// Private component units against the production reply/state/I/O implementation.
// Replies and transport completion are scripted; only test-owned Windows events
// are real. No package/device/control capability is fabricated, and no actual
// DeviceIoControl, software device, monitor or kernel IRP is exercised here.
#include "OwnedDisplayControl.cpp"

#include <cstdio>
#include <functional>
#include <string>

namespace {
namespace display = reviewops::display;
namespace control = reviewops::display::control;
namespace impl = reviewops::display::control::internal;
namespace device = reviewops::display::softwaredevice;

struct TestFailure { const char* reason; DWORD code; };
[[noreturn]] void TestFail(const char* reason, DWORD code = ERROR_SUCCESS) { throw TestFailure{reason, code}; }
void Need(bool condition, const char* reason) { if (!condition) TestFail(reason, GetLastError()); }
bool cleanupComplete = true;
unsigned liveFixtures = 0;
std::string observations;
void Observe(const char* key, uint64_t value) {
    std::array<char, 128> text{};
    std::snprintf(text.data(), text.size(), "%s\"%s\":%llu", observations.empty() ? "" : ",", key,
        static_cast<unsigned long long>(value));
    observations += text.data();
}
template<typename Function> void Refuses(Function function, const char* reason) {
    try { function(); }
    catch (const impl::Failure& error) {
        Need(!std::strcmp(error.reason, reason), "TEST_REFUSAL_REASON_DIFFERENT");
        return;
    }
    TestFail("TEST_EXPECTED_REFUSAL_MISSING");
}
bool Live(HANDLE handle) { DWORD flags = 0; return !!GetHandleInformation(handle, &flags); }
GUID Id(DWORD value) { return {value, 0x1234, 0x4567, {0x80, 1, 2, 3, 4, 5, 6, 7}}; }
device::TrustedProjectBinding Binding() { return {Id(11), Id(12), Id(13)}; }
display::Reply Empty(display::State state = display::State::Empty) {
    display::Reply reply{};
    reply.header = {sizeof(reply), display::ProtocolVersion};
    reply.deviceId = Id(1); reply.fileOwnerId = Id(2);
    reply.state = state; reply.connectorIndex = UINT32_MAX;
    return reply;
}
display::Reply Attached(bool fourK = false) {
    auto reply = Empty(); reply.monitorId = Id(3);
    reply.state = display::State::Attached; reply.connectorIndex = 0;
    reply.width = fourK ? 3840 : 1920; reply.height = fourK ? 2160 : 1080;
    reply.refreshHz = 60; reply.adapterLuidLow = 7; reply.adapterLuidHigh = -2; reply.osTargetId = 9;
    return reply;
}
impl::ProtocolState OwnedState() {
    impl::ProtocolState state; state.PinInitial(Empty()); state.AcceptCreate(Attached(), 1920, 1080); return state;
}

enum class Script { Synchronous, PendingSuccess, ShortReply, StartFailure, TimeoutSuccess, TimeoutAborted, Unconfirmed };
struct Fixture;
std::vector<Fixture*> fixtures;
BOOL WINAPI ScriptSend(HANDLE, DWORD, LPVOID, DWORD, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
BOOL WINAPI ScriptResult(HANDLE, LPOVERLAPPED, LPDWORD, DWORD, BOOL);
BOOL WINAPI ScriptCancel(HANDLE, LPOVERLAPPED);
struct Fixture {
    impl::Slot slot;
    Script script;
    display::Reply reply = Attached();
    unsigned sends = 0, results = 0, cancels = 0;
    std::vector<DWORD> waits;
    LPOVERLAPPED original = nullptr;
    HANDLE pendingEvent = nullptr;
    void* inputAddress = nullptr;
    void* outputAddress = nullptr;
    DWORD inputBytes = 0, sentCode = 0;
    bool forceComplete = false, argumentsValid = true;
    explicit Fixture(Script value) : script(value) {
        slot.file = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!slot.file) TestFail("TEST_OWNED_FILE_EVENT_FAILED", GetLastError());
        slot.everOpened = true; slot.ops = {&ScriptSend, &ScriptResult, &ScriptCancel};
        try { fixtures.push_back(this); } catch (...) {
            if (!CloseHandle(slot.file)) cleanupComplete = false;
            slot.file = INVALID_HANDLE_VALUE; throw;
        }
        ++liveFixtures;
    }
    Fixture(const Fixture&) = delete;
    Fixture& operator=(const Fixture&) = delete;
    ~Fixture() {
        // This completes only a scripted request. A real outstanding kernel IRP
        // must never be forced complete or discarded by a production cleanup.
        try {
            if (slot.pending) {
                const HANDLE outstandingEvent = slot.pending->overlapped.hEvent;
                forceComplete = true;
                if (!slot.Drain(0) || slot.pending || Live(outstandingEvent)) cleanupComplete = false;
            }
            if (pendingEvent && !slot.pending && Live(pendingEvent)) cleanupComplete = false;
            const HANDLE file = slot.file;
            if (!slot.CloseFile() || (file != INVALID_HANDLE_VALUE && Live(file))) cleanupComplete = false;
        } catch (...) { cleanupComplete = false; }
        for (auto it = fixtures.begin(); it != fixtures.end(); ++it) if (*it == this) { fixtures.erase(it); break; }
        --liveFixtures;
    }
    impl::IoResult Query() {
        const display::Header request{sizeof(display::Header), display::ProtocolVersion};
        return impl::Issue(slot, display::Query, &request, sizeof(request));
    }
    impl::IoResult Create() {
        const display::CreateRequest request{{sizeof(display::CreateRequest), display::ProtocolVersion}, 1920, 1080, 60, 0};
        return impl::Issue(slot, display::Create, &request, sizeof(request));
    }
};
Fixture& Find(HANDLE file) {
    for (auto* fixture : fixtures) if (fixture->slot.file == file) return *fixture;
    TestFail("TEST_SCRIPT_FILE_NOT_OWNED");
}
BOOL WINAPI ScriptSend(HANDLE file, DWORD code, LPVOID input, DWORD inputSize, LPVOID output, DWORD outputSize,
                       LPDWORD immediateBytes, LPOVERLAPPED overlapped) {
    auto& fixture = Find(file); ++fixture.sends;
    fixture.original = overlapped; fixture.pendingEvent = overlapped->hEvent;
    fixture.inputAddress = input; fixture.outputAddress = output;
    fixture.inputBytes = inputSize; fixture.sentCode = code;
    fixture.argumentsValid = fixture.argumentsValid && fixture.slot.pending &&
        input == fixture.slot.pending->input.data() && output == &fixture.slot.pending->output &&
        overlapped == &fixture.slot.pending->overlapped && outputSize == sizeof(display::Reply) &&
        immediateBytes == nullptr && inputSize <= sizeof(display::RemoveRequest) && Live(overlapped->hEvent);
    if (fixture.script == Script::StartFailure) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    std::memcpy(output, &fixture.reply, sizeof(fixture.reply));
    if (fixture.script == Script::Synchronous || fixture.script == Script::ShortReply) {
        overlapped->Internal = 0; SetEvent(overlapped->hEvent); return TRUE;
    }
    // STATUS_PENDING is necessary: a zero-initialized OVERLAPPED would falsely
    // look complete to HasOverlappedIoCompleted in this simulated transport.
    overlapped->Internal = 0x103; SetLastError(ERROR_IO_PENDING); return FALSE;
}
BOOL WINAPI ScriptResult(HANDLE file, LPOVERLAPPED overlapped, LPDWORD bytes, DWORD wait, BOOL alertable) {
    auto& fixture = Find(file); ++fixture.results; fixture.waits.push_back(wait);
    fixture.argumentsValid = fixture.argumentsValid && overlapped == fixture.original && !alertable;
    if (fixture.forceComplete) {
        overlapped->Internal = 0xc0000120UL; SetEvent(overlapped->hEvent);
        *bytes = 0; SetLastError(ERROR_OPERATION_ABORTED); return FALSE;
    }
    if (fixture.script == Script::Unconfirmed ||
        ((fixture.script == Script::TimeoutSuccess || fixture.script == Script::TimeoutAborted) && fixture.results == 1)) {
        SetLastError(WAIT_TIMEOUT); return FALSE;
    }
    if (fixture.script == Script::TimeoutAborted) {
        overlapped->Internal = 0xc0000120UL; SetEvent(overlapped->hEvent);
        *bytes = 0; SetLastError(ERROR_OPERATION_ABORTED); return FALSE;
    }
    overlapped->Internal = 0; SetEvent(overlapped->hEvent);
    *bytes = static_cast<DWORD>(fixture.script == Script::ShortReply ? sizeof(display::Reply) - 1 : sizeof(display::Reply));
    return TRUE;
}
BOOL WINAPI ScriptCancel(HANDLE file, LPOVERLAPPED overlapped) {
    auto& fixture = Find(file); ++fixture.cancels;
    fixture.argumentsValid = fixture.argumentsValid && overlapped == fixture.original;
    if (fixture.script == Script::Unconfirmed) { SetLastError(ERROR_NOT_FOUND); return FALSE; }
    return TRUE;
}

void HeaderBindingRefusals() {
    using Mutation = std::function<void(display::Reply&)>;
    const std::array<Mutation, 11> changes{{
        [](auto& r) { --r.header.size; }, [](auto& r) { ++r.header.version; }, [](auto& r) { r.reserved = 1; },
        [](auto& r) { r.state = static_cast<display::State>(999); }, [](auto& r) { r.deviceId = {}; },
        [](auto& r) { r.fileOwnerId = {}; }, [](auto& r) { r.fileOwnerId = r.deviceId; },
        [](auto& r) { r.deviceId.Data3 = 0x3567; }, [](auto& r) { r.fileOwnerId.Data3 = 0x3567; },
        [](auto& r) { r.deviceId.Data4[0] = 0x40; }, [](auto& r) { r.fileOwnerId.Data4[0] = 0xc0; }
    }};
    impl::ValidateReply(Empty());
    for (const auto& change : changes) { auto reply = Empty(); change(reply); Refuses([&] { impl::ValidateReply(reply); }, "CONTROL_REPLY_BINDING_REFUSED"); }
    Observe("independentHeaderAndFileBindingRefusals", changes.size());
}
void MonitorShapeRefusals() {
    using Mutation = std::function<void(display::Reply&)>;
    const std::array<Mutation, 11> attachedChanges{{
        [](auto& r) { r.monitorId = r.deviceId; }, [](auto& r) { r.monitorId = r.fileOwnerId; },
        [](auto& r) { r.monitorId.Data3 = 0x3567; }, [](auto& r) { r.monitorId.Data4[0] = 0x40; },
        [](auto& r) { r.connectorIndex = display::MaximumMonitors; }, [](auto& r) { r.refreshHz = 59; },
        [](auto& r) { r.width = 1919; }, [](auto& r) { r.height = 1079; },
        [](auto& r) { r.width = 3840; }, [](auto& r) { r.state = display::State::Empty; },
        [](auto& r) { r.state = display::State::AdapterNotReady; }
    }};
    for (const auto& change : attachedChanges) { auto reply = Attached(); change(reply); Refuses([&] { impl::ValidateReply(reply); }, "CONTROL_REPLY_MONITOR_REFUSED"); }
    const std::array<Mutation, 10> emptyChanges{{
        [](auto& r) { r.connectorIndex = 0; }, [](auto& r) { r.width = 1; }, [](auto& r) { r.height = 1; },
        [](auto& r) { r.refreshHz = 1; }, [](auto& r) { r.nativeStatus = 1; }, [](auto& r) { r.adapterLuidLow = 1; },
        [](auto& r) { r.adapterLuidHigh = -1; }, [](auto& r) { r.osTargetId = 1; },
        [](auto& r) { r.state = display::State::Attached; }, [](auto& r) { r.state = display::State::RemovalUnconfirmed; }
    }};
    for (const auto& change : emptyChanges) { auto reply = Empty(); change(reply); Refuses([&] { impl::ValidateReply(reply); }, "CONTROL_REPLY_MONITOR_REFUSED"); }
    auto reply = Attached(); reply.nativeStatus = 1;
    Refuses([&] { impl::ValidateReply(reply); }, "CONTROL_REPLY_NATIVE_STATUS_REFUSED");
    reply.state = display::State::RemovalUnconfirmed; reply.nativeStatus = 0;
    Refuses([&] { impl::ValidateReply(reply); }, "CONTROL_REPLY_NATIVE_STATUS_REFUSED");
    reply.nativeStatus = 1; impl::ValidateReply(reply); impl::ValidateReply(Attached(true));
    Observe("malformedMonitorShapesRefused", attachedChanges.size() + emptyChanges.size() + 2);
}
void InitialMonitorAdoptionRefused() {
    unsigned refused = 0;
    for (const auto stateValue : {display::State::Attached, display::State::RemovalUnconfirmed, display::State::FileClosing}) {
        auto reply = Attached(); reply.state = stateValue;
        if (stateValue == display::State::RemovalUnconfirmed) reply.nativeStatus = 1;
        impl::ProtocolState state;
        Refuses([&] { state.PinInitial(reply); }, "CONTROL_INITIAL_MONITOR_ADOPTION_REFUSED");
        Need(state.sticky && !state.pinned && impl::Zero(state.ownedMonitor.monitorId), "TEST_INITIAL_REPLY_ADOPTED_MONITOR"); ++refused;
    }
    impl::ProtocolState state; state.PinInitial(Empty());
    Refuses([&] { state.PinInitial(Empty()); }, "CONTROL_INITIAL_REPLAY_REFUSED");
    Need(state.sticky && state.pinned, "TEST_INITIAL_REPLAY_NOT_RETIRED");
    Observe("foreignInitialMonitorRepliesRefused", refused); Observe("initialReplayRefused", 1);
}
void PinnedFileAndMonitorTuples() {
    using Mutation = std::function<void(display::Reply&)>;
    const std::array<Mutation, 2> fileChanges{{[](auto& r) { r.deviceId = Id(20); }, [](auto& r) { r.fileOwnerId = Id(21); }}};
    for (const auto& change : fileChanges) {
        auto state = OwnedState(); auto reply = Attached(); change(reply);
        Refuses([&] { state.AcceptQuery(reply); }, "CONTROL_ORIGINAL_FILE_CHANGED");
        Need(state.sticky && impl::Same(state.ownedMonitor.monitorId, Id(3)), "TEST_FILE_DRIFT_ADOPTED");
    }
    const std::array<Mutation, 5> monitorChanges{{
        [](auto& r) { r.monitorId = Id(22); }, [](auto& r) { ++r.connectorIndex; },
        [](auto& r) { ++r.adapterLuidLow; }, [](auto& r) { ++r.adapterLuidHigh; }, [](auto& r) { ++r.osTargetId; }
    }};
    for (const auto& change : monitorChanges) {
        auto state = OwnedState(); auto reply = Attached(); change(reply);
        Refuses([&] { state.AcceptQuery(reply); }, "CONTROL_ORIGINAL_MONITOR_CHANGED");
        Need(state.sticky && impl::SameMonitor(state.ownedMonitor, Attached()), "TEST_MONITOR_DRIFT_ADOPTED");
    }
    auto state = OwnedState();
    Refuses([&] { state.AcceptQuery(Attached(true)); }, "CONTROL_ORIGINAL_MONITOR_CHANGED");
    for (const auto& change : std::array<Mutation, 3>{{[](auto& r) { ++r.width; }, [](auto& r) { ++r.height; }, [](auto& r) { ++r.refreshHz; }}}) {
        state = OwnedState(); auto reply = Attached(); change(reply);
        Refuses([&] { state.AcceptQuery(reply); }, "CONTROL_REPLY_MONITOR_REFUSED"); Need(state.sticky, "TEST_MODE_DRIFT_NOT_BLOCKED");
    }
    state = OwnedState(); Refuses([&] { state.AcceptQuery(Empty()); }, "CONTROL_ORIGINAL_MONITOR_CHANGED");
    Need(!impl::Zero(state.ownedMonitor.monitorId), "TEST_QUERY_CLEARED_MONITOR_AUTHORITY");
    Observe("pinnedTupleAndShapeDriftsRefused", 12); Observe("queryCannotAcknowledgeRemove", 1);
}
void CreateRemoveReceipts() {
    impl::ProtocolState state; state.PinInitial(Empty());
    for (const bool fourK : {false, true}) {
        const auto reply = Attached(fourK); state.AcceptQuery(Empty());
        state.AcceptCreate(reply, reply.width, reply.height); state.AcceptQuery(reply);
        Need(!state.sticky && !state.cleanEmpty && impl::SameMonitor(state.ownedMonitor, reply), "TEST_CREATE_RECEIPT_NOT_PINNED");
        state.AcceptRemove(Empty()); Need(!state.sticky && state.cleanEmpty && impl::Zero(state.ownedMonitor.monitorId), "TEST_REMOVE_RECEIPT_NOT_EMPTY");
    }
    impl::ProtocolState wrongMode; wrongMode.PinInitial(Empty());
    Refuses([&] { wrongMode.AcceptCreate(Attached(true), 1920, 1080); }, "CONTROL_CREATE_RESULT_UNCONFIRMED");
    Need(wrongMode.sticky && impl::Zero(wrongMode.ownedMonitor.monitorId), "TEST_WRONG_MODE_ADOPTED");
    auto foreign = Empty(); foreign.fileOwnerId = Id(23); auto owned = OwnedState();
    Refuses([&] { owned.AcceptRemove(foreign); }, "CONTROL_ORIGINAL_FILE_CHANGED");
    Need(!impl::Zero(owned.ownedMonitor.monitorId), "TEST_FOREIGN_REMOVE_CLEARED_AUTHORITY");
    owned = OwnedState(); Refuses([&] { owned.AcceptRemove(Attached()); }, "CONTROL_REMOVE_RESULT_UNCONFIRMED");
    Need(owned.sticky && !impl::Zero(owned.ownedMonitor.monitorId), "TEST_NONEMPTY_REMOVE_CLEARED_AUTHORITY");
    Observe("metadataModeRoundTrips", 2); Observe("uncertainCreateOrRemoveReceiptsRefused", 3);
}
void StickyUncertaintyNoRearm() {
    unsigned stickyPaths = 0;
    for (const auto stateValue : {display::State::RemovalUnconfirmed, display::State::FileClosing, display::State::DeviceStopping}) {
        auto state = OwnedState(); auto reply = Attached(); reply.state = stateValue;
        if (stateValue == display::State::RemovalUnconfirmed) reply.nativeStatus = 1;
        state.AcceptQuery(reply); Need(state.sticky, "TEST_TERMINAL_STATE_NOT_STICKY");
        Refuses([&] { state.AcceptRemove(Empty()); }, "CONTROL_REMOVE_AUTHORITY_REFUSED");
        Need(!impl::Zero(state.ownedMonitor.monitorId), "TEST_STICKY_STATE_LOST_ORIGINAL_MONITOR"); ++stickyPaths;
    }
    impl::ProtocolState empty; empty.PinInitial(Empty()); empty.Block(); empty.AcceptQuery(Empty());
    Need(empty.sticky && !empty.cleanEmpty, "TEST_EMPTY_QUERY_REARMED_UNCERTAINTY");
    Refuses([&] { empty.AcceptCreate(Attached(), 1920, 1080); }, "CONTROL_CREATE_AUTHORITY_REFUSED");
    impl::ProtocolState notPinned;
    Refuses([&] { notPinned.AcceptQuery(Empty()); }, "CONTROL_PROTOCOL_NOT_PINNED");
    Need(notPinned.sticky, "TEST_UNPINNED_QUERY_NOT_BLOCKED");
    Observe("terminalStateStickyPaths", stickyPaths); Observe("emptyReplyCannotRearm", 1); Observe("unadmittedQueryRefused", 1);
}
void IoConfirmedReply() {
    for (const auto script : {Script::Synchronous, Script::PendingSuccess}) {
        Fixture fixture(script); const auto io = fixture.Query();
        Need(io.attempted && io.completed && !io.unconfirmed && !io.error && !io.completionError && !io.cancelRequested && !fixture.slot.pending,
             "TEST_CONFIRMED_IO_METADATA_DIFFERENT");
        Need(fixture.argumentsValid && fixture.sends == 1 && fixture.results == 1 && !fixture.cancels &&
             fixture.waits == std::vector<DWORD>{impl::IoWaitMs} && impl::SameMonitor(io.reply, fixture.reply), "TEST_CONFIRMED_REPLY_ORIGINAL_STORAGE_DIFFERENT");
        Need(Live(fixture.slot.file), "TEST_CONFIRMED_IO_CLOSED_ORIGINAL_FILE");
        Need(!Live(fixture.pendingEvent), "TEST_CONFIRMED_IO_EVENT_NOT_RETIRED");
    }
    Fixture denied(Script::StartFailure); const auto failed = denied.Create();
    Need(failed.attempted && failed.completed && !failed.unconfirmed && failed.error == ERROR_ACCESS_DENIED &&
         failed.completionError == ERROR_ACCESS_DENIED && !failed.cancelRequested && !denied.results && !denied.slot.pending,
         "TEST_START_FAILURE_LIFETIME_DIFFERENT");
    Need(!Live(denied.pendingEvent), "TEST_START_FAILURE_EVENT_NOT_RETIRED");
    Observe("scriptedConfirmedTransportPaths", 2); Observe("startFailureRetiredWithoutRetry", 1);
}
void IoShortReplyRefused() {
    Fixture fixture(Script::ShortReply); const auto io = fixture.Create();
    Need(io.attempted && io.completed && !io.unconfirmed && io.error == ERROR_BAD_LENGTH && !io.completionError &&
         impl::Zero(io.reply.monitorId) && !fixture.slot.pending && fixture.sends == 1 && !fixture.cancels, "TEST_SHORT_REPLY_ADOPTED");
    Need(fixture.sentCode == display::Create && fixture.inputBytes == sizeof(display::CreateRequest) && fixture.argumentsValid,
         "TEST_CREATE_REQUEST_NOT_ORIGINAL");
    Need(!Live(fixture.pendingEvent), "TEST_SHORT_REPLY_EVENT_NOT_RETIRED");
    Observe("shortReplyRefusedWithoutAdoption", 1); Observe("scriptedSendCalls", fixture.sends);
}
void IoTimeoutDrainedNoAdoption() {
    for (const auto script : {Script::TimeoutSuccess, Script::TimeoutAborted}) {
        Fixture fixture(script); const auto io = fixture.Create();
        Need(io.attempted && io.completed && !io.unconfirmed && io.error == WAIT_TIMEOUT && io.cancelRequested && !io.cancelError &&
             impl::Zero(io.reply.monitorId) && !fixture.slot.pending, "TEST_TIMEOUT_LATE_REPLY_ADOPTED");
        Need(io.completionError == (script == Script::TimeoutSuccess ? ERROR_SUCCESS : ERROR_OPERATION_ABORTED), "TEST_DRAIN_FAILURE_EVIDENCE_LOST");
        Need(fixture.argumentsValid && fixture.sends == 1 && fixture.cancels == 1 && fixture.results == 2 &&
             fixture.waits == std::vector<DWORD>({impl::IoWaitMs, impl::DrainWaitMs}), "TEST_TIMEOUT_REQUEST_REPLAYED");
        Need(Live(fixture.slot.file), "TEST_DRAIN_CLOSED_ORIGINAL_FILE");
        Need(!Live(fixture.pendingEvent), "TEST_DRAIN_EVENT_NOT_RETIRED");
    }
    Observe("lateCompletionPathsDrained", 2); Observe("lateReplyNeverAdopted", 1); Observe("actualKernelIrpsExercised", 0);
}
void IoUnconfirmedRetainsMemory() {
    Fixture fixture(Script::Unconfirmed); const auto io = fixture.Create();
    Need(io.attempted && !io.completed && io.unconfirmed && io.error == WAIT_TIMEOUT && io.completionError == ERROR_IO_INCOMPLETE &&
         io.cancelRequested && io.cancelError == ERROR_NOT_FOUND && fixture.slot.pending, "TEST_CANCEL_NOT_FOUND_MISTAKEN_FOR_COMPLETION");
    auto* const pending = fixture.slot.pending.get(); const HANDLE event = pending->overlapped.hEvent;
    const HANDLE file = fixture.slot.file;
    Need(fixture.inputAddress == pending->input.data() && fixture.outputAddress == &pending->output &&
         fixture.original == &pending->overlapped && Live(event) && Live(file), "TEST_PENDING_STORAGE_NOT_RETAINED");
    display::CreateRequest copied{}; std::memcpy(&copied, pending->input.data(), sizeof(copied));
    Need(copied.width == 1920 && copied.height == 1080 && copied.header.size == sizeof(copied), "TEST_PENDING_REQUEST_COPY_LOST");
    Need(!fixture.slot.CloseFile() && Live(file), "TEST_PENDING_FILE_CLOSED");
    Refuses([&] { fixture.Query(); }, "CONTROL_IO_LIFETIME_REFUSED");
    Need(!fixture.slot.Drain(0) && fixture.slot.pending.get() == pending && Live(event) && fixture.sends == 1,
         "TEST_UNCONFIRMED_DRAIN_RELEASED_MEMORY");
    fixture.forceComplete = true;
    Need(fixture.slot.Drain(0) && !fixture.slot.pending && !Live(event) && Live(file), "TEST_LATE_ABORT_NOT_DRAINED");
    Need(fixture.slot.CloseFile() && !Live(file) && fixture.slot.closed, "TEST_ORIGINAL_FILE_NOT_RETIRED");
    Observe("unconfirmedStorageRetained", 1); Observe("cancelNotFoundNotCompletion", 1); Observe("replaySendCalls", fixture.sends - 1);
    Observe("scriptedLateAbortDrained", 1);
}
void CloseScopeAndIsolation() {
    Fixture a(Script::Unconfirmed), b(Script::Synchronous);
    const HANDLE fileA = a.slot.file, fileB = b.slot.file;
    const auto unresolved = a.Create(); Need(unresolved.unconfirmed && a.slot.pending, "TEST_A_REQUEST_NOT_PENDING");
    const HANDLE eventA = a.slot.pending->overlapped.hEvent;
    Need(!a.slot.CloseFile() && Live(fileA) && Live(fileB), "TEST_A_EARLY_CLOSE_TOUCHED_FILE");
    const auto observedB = b.Query(); Need(!observedB.error && b.sends == 1 && a.sends == 1, "TEST_A_PENDING_BLOCKED_B_TRANSPORT");
    Need(b.slot.CloseFile() && !Live(fileB) && Live(fileA) && Live(eventA), "TEST_B_CLOSE_TOUCHED_A_STORAGE");
    Need(b.slot.CloseFile() && b.slot.closed, "TEST_REPEAT_CLOSE_NOT_IDEMPOTENT");
    a.forceComplete = true; Need(a.slot.Drain(0) && !Live(eventA), "TEST_A_LATE_COMPLETION_NOT_RETIRED");
    Need(a.slot.CloseFile() && !Live(fileA) && a.sends == 1 && a.cancels == 1, "TEST_A_CLOSE_REPLAYED_REQUEST");
    impl::Slot unopened; Need(unopened.CloseFile(), "TEST_UNOPENED_CLOSE_NOT_EMPTY");
    Observe("independentOriginalFiles", 2); Observe("closeSentAdditionalRequests", 0); Observe("testEventsRetired", 3);
}
void PublicCapabilityAdmissionRefusals() {
    auto& registry = impl::ProcessRegistry(); size_t before = 0;
    { std::lock_guard<std::mutex> lock(registry.gate); before = registry.entries.size(); }
    unsigned rejected = 0;
    for (unsigned index = 0; index != 5; ++index) {
        auto binding = Binding();
        if (index == 0) binding.projectId = {};
        if (index == 1) binding.projectBirth = binding.projectId;
        if (index == 2) binding.sessionId = binding.projectId;
        if (index == 3) binding.sessionId = binding.projectBirth;
        const auto opening = control::OpenOwnedDisplayControl({}, binding);
        const auto& observation = opening.observation;
        Need(!opening.owner && !observation.ioAttempted && !observation.ioCompleted && !observation.mutationAttempted &&
             !observation.hasReply && !observation.protocolConfirmed && observation.mutationsBlocked, "TEST_PUBLIC_NULL_CAPABILITY_ADMITTED");
        const char* expected = index == 4 ? "CONTROL_DEVICE_CAPABILITY_REFUSED" : "CONTROL_PROJECT_BINDING_REFUSED";
        Need(!std::strcmp(observation.reason, expected), "TEST_PUBLIC_CAPABILITY_REFUSAL_DIFFERENT"); ++rejected;
    }
    { std::lock_guard<std::mutex> lock(registry.gate); Need(registry.entries.size() == before, "TEST_REFUSAL_MUTATED_REGISTRY"); }
    Observe("publicFactoryAdmissionRefusals", rejected); Observe("registryEntriesAdded", 0); Observe("manufacturedDeviceCapabilities", 0);
}

struct Case { const char* name; const char* operation; const char* scope; void (*run)(); };
const std::array<Case, 12> cases{{
    {"reply-header-binding-refusals", "validate-reply", "synthetic-reply-metadata", &HeaderBindingRefusals},
    {"reply-monitor-shape-refusals", "validate-reply", "synthetic-reply-metadata", &MonitorShapeRefusals},
    {"initial-monitor-adoption-refused", "pin-initial", "private-production-state", &InitialMonitorAdoptionRefused},
    {"pinned-file-and-monitor-tuples", "query-state", "private-production-state", &PinnedFileAndMonitorTuples},
    {"create-remove-receipts", "create-remove-state", "private-production-state", &CreateRemoveReceipts},
    {"sticky-uncertainty-no-rearm", "block-state", "private-production-state", &StickyUncertaintyNoRearm},
    {"io-confirmed-reply", "issue", "scripted-io-owned-real-events", &IoConfirmedReply},
    {"io-short-reply-refused", "issue-create", "scripted-io-owned-real-events", &IoShortReplyRefused},
    {"io-timeout-drained-no-adoption", "issue-cancel-drain", "scripted-io-owned-real-events", &IoTimeoutDrainedNoAdoption},
    {"io-unconfirmed-retains-memory", "issue-retain-late-drain", "scripted-io-owned-real-events", &IoUnconfirmedRetainsMemory},
    {"close-scope-and-a-b-slot-isolation", "drain-close", "scripted-io-owned-real-events", &CloseScopeAndIsolation},
    {"public-capability-admission-refusals", "public-open", "real-factory-refusal-no-device", &PublicCapabilityAdmissionRefusals}
}};
} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || std::wcscmp(argv[1], L"--self-test")) return 2;
    unsigned passed = 0, failed = 0;
    for (const auto& test : cases) {
        observations.clear(); const ULONGLONG started = GetTickCount64();
        const char* reason = "COMPONENT_UNIT_PASSED"; DWORD code = ERROR_SUCCESS; bool success = false;
        try { test.run(); success = true; }
        catch (const TestFailure& error) { reason = error.reason; code = error.code; }
        catch (const impl::Failure& error) { reason = error.reason; code = error.code; }
        catch (...) { reason = "TEST_UNHANDLED_EXCEPTION"; code = ERROR_UNHANDLED_EXCEPTION; }
        if (liveFixtures || !fixtures.empty()) { cleanupComplete = false; success = false; reason = "TEST_FIXTURE_LIFETIME_UNCONFIRMED"; }
        if (!cleanupComplete) { success = false; reason = "TEST_OWNED_EVENT_CLEANUP_UNCONFIRMED"; }
        if (success) ++passed; else ++failed;
        std::printf("{\"type\":\"case\",\"name\":\"%s\",\"status\":\"%s\",\"operation\":\"%s\",\"scope\":\"%s\",\"reason\":\"%s\",\"win32\":%lu,\"observations\":{%s},\"elapsedMs\":%llu}\n",
            test.name, success ? "passed" : "failed", test.operation, test.scope, reason, static_cast<unsigned long>(code), observations.c_str(),
            static_cast<unsigned long long>(GetTickCount64() - started));
    }
    const bool success = !failed && cleanupComplete && !liveFixtures && fixtures.empty();
    std::printf("{\"type\":\"summary\",\"version\":1,\"status\":\"%s\",\"counts\":{\"passed\":%u,\"failed\":%u,\"total\":12},\"cleanupComplete\":%s,\"scope\":\"Private production state and scripted transport with owned Windows events; no real driver or kernel IRP exercised\",\"actualDeviceIoControlCalls\":0,\"actualSoftwareDevicesCreated\":0,\"actualMonitorsCreated\":0,\"positiveInstalledControlTested\":false,\"driverInstalled\":false,\"displayChanged\":false}\n",
        success ? "passed-owned-control-units-only" : "failed", passed, failed, cleanupComplete ? "true" : "false");
    return success ? 0 : 1;
}
