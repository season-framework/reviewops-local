#include "OwnedDisplayControl.h"

#include <array>
#include <atomic>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <utility>
#include <vector>

namespace reviewops::display::control {
namespace internal {
constexpr DWORD IoWaitMs = 5000, DrainWaitMs = 2000;
struct Failure { const char* reason; DWORD code; bool uncertain; };
[[noreturn]] void Fail(const char* reason, DWORD code = ERROR_SUCCESS, bool uncertain = true) { throw Failure{reason, code, uncertain}; }
[[noreturn]] void Refuse(const char* reason) { Fail(reason, ERROR_SUCCESS, false); }
bool Same(const GUID& a, const GUID& b) { return !std::memcmp(&a, &b, sizeof(GUID)); }
bool Zero(const GUID& value) { const GUID zero{}; return Same(value, zero); }
bool RandomId(const GUID& value) { return !Zero(value) && (value.Data3 & 0xf000U) == 0x4000U && (value.Data4[0] & 0xc0U) == 0x80U; }
bool SameBinding(const softwaredevice::TrustedProjectBinding& a, const softwaredevice::TrustedProjectBinding& b) {
    return Same(a.projectId, b.projectId) && Same(a.projectBirth, b.projectBirth) && Same(a.sessionId, b.sessionId);
}
void CheckBinding(const softwaredevice::TrustedProjectBinding& value) {
    if (Zero(value.projectId) || Zero(value.projectBirth) || Zero(value.sessionId) || Same(value.projectId, value.projectBirth) ||
        Same(value.projectId, value.sessionId) || Same(value.projectBirth, value.sessionId)) Fail("CONTROL_PROJECT_BINDING_REFUSED");
}
bool KnownState(State state) {
    switch (state) {
    case State::AdapterNotReady: case State::Empty: case State::Attached:
    case State::RemovalUnconfirmed: case State::FileClosing: case State::DeviceStopping: return true;
    default: return false;
    }
}
void ValidateReply(const Reply& reply) {
    if (reply.header.size != sizeof(reply) || reply.header.version != ProtocolVersion || reply.reserved || !KnownState(reply.state) ||
        !RandomId(reply.deviceId) || !RandomId(reply.fileOwnerId) || Same(reply.deviceId, reply.fileOwnerId)) Fail("CONTROL_REPLY_BINDING_REFUSED");
    if (!Zero(reply.monitorId)) {
        if (!RandomId(reply.monitorId) || Same(reply.monitorId, reply.deviceId) || Same(reply.monitorId, reply.fileOwnerId) ||
            reply.connectorIndex >= MaximumMonitors || reply.refreshHz != 60 ||
            !((reply.width == 1920 && reply.height == 1080) || (reply.width == 3840 && reply.height == 2160)) ||
            reply.state == State::Empty || reply.state == State::AdapterNotReady) Fail("CONTROL_REPLY_MONITOR_REFUSED");
    } else if (reply.connectorIndex != UINT32_MAX || reply.width || reply.height || reply.refreshHz || reply.nativeStatus ||
        reply.adapterLuidLow || reply.adapterLuidHigh || reply.osTargetId || reply.state == State::Attached || reply.state == State::RemovalUnconfirmed)
        Fail("CONTROL_REPLY_MONITOR_REFUSED");
    if ((reply.state == State::Attached && reply.nativeStatus) || (reply.state == State::RemovalUnconfirmed && !reply.nativeStatus))
        Fail("CONTROL_REPLY_NATIVE_STATUS_REFUSED");
}
bool SameMonitor(const Reply& a, const Reply& b) {
    return Same(a.monitorId, b.monitorId) && a.connectorIndex == b.connectorIndex && a.width == b.width && a.height == b.height &&
        a.refreshHz == b.refreshHz && a.adapterLuidLow == b.adapterLuidLow && a.adapterLuidHigh == b.adapterLuidHigh && a.osTargetId == b.osTargetId;
}
// The production state transitions are also usable by a private test translation
// unit. They grant no file/device capability and never perform native I/O.
struct ProtocolState {
    bool pinned = false, sticky = false, cleanEmpty = false;
    GUID deviceId{}, ownerId{};
    Reply ownedMonitor{}, lastReply{};
    void Block() { sticky = true; cleanEmpty = false; }
    void CheckPinned(const Reply& reply) const {
        ValidateReply(reply);
        if (pinned && (!Same(deviceId, reply.deviceId) || !Same(ownerId, reply.fileOwnerId))) Fail("CONTROL_ORIGINAL_FILE_CHANGED");
    }
    void ObserveState(const Reply& reply) {
        lastReply = reply;
        if (reply.state == State::RemovalUnconfirmed || reply.state == State::FileClosing || reply.state == State::DeviceStopping) Block();
        cleanEmpty = !sticky && Zero(ownedMonitor.monitorId) && (reply.state == State::Empty || reply.state == State::AdapterNotReady);
    }
    void PinInitial(const Reply& reply) {
        try {
            if (pinned || sticky) Fail("CONTROL_INITIAL_REPLAY_REFUSED");
            ValidateReply(reply);
            if (!Zero(reply.monitorId)) Fail("CONTROL_INITIAL_MONITOR_ADOPTION_REFUSED");
            deviceId = reply.deviceId; ownerId = reply.fileOwnerId; pinned = true; ObserveState(reply);
        } catch (...) { Block(); throw; }
    }
    void AcceptQuery(const Reply& reply) {
        try {
            if (!pinned) Fail("CONTROL_PROTOCOL_NOT_PINNED"); CheckPinned(reply);
            if (!Same(reply.monitorId, ownedMonitor.monitorId) || (!Zero(ownedMonitor.monitorId) && !SameMonitor(reply, ownedMonitor)))
                Fail("CONTROL_ORIGINAL_MONITOR_CHANGED");
            ObserveState(reply);
        } catch (...) { Block(); throw; }
    }
    void AcceptCreate(const Reply& reply, uint32_t width, uint32_t height) {
        try {
            if (!pinned || sticky || !Zero(ownedMonitor.monitorId)) Fail("CONTROL_CREATE_AUTHORITY_REFUSED");
            CheckPinned(reply);
            if (reply.state != State::Attached || Zero(reply.monitorId) || reply.width != width || reply.height != height)
                Fail("CONTROL_CREATE_RESULT_UNCONFIRMED");
            ownedMonitor = reply; ObserveState(reply);
        } catch (...) { Block(); throw; }
    }
    void AcceptRemove(const Reply& reply) {
        try {
            if (!pinned || sticky || Zero(ownedMonitor.monitorId)) Fail("CONTROL_REMOVE_AUTHORITY_REFUSED");
            CheckPinned(reply);
            if (reply.state != State::Empty || !Zero(reply.monitorId)) Fail("CONTROL_REMOVE_RESULT_UNCONFIRMED");
            ownedMonitor = {}; ObserveState(reply);
        } catch (...) { Block(); throw; }
    }
};
struct PendingIo {
    OVERLAPPED overlapped{};
    std::array<BYTE, sizeof(RemoveRequest)> input{};
    Reply output{};
    DWORD bytes = 0;
    PendingIo() {
        overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!overlapped.hEvent) Fail("CONTROL_IO_EVENT_FAILED", GetLastError());
    }
    ~PendingIo() { if (overlapped.hEvent) CloseHandle(overlapped.hEvent); }
};
// Private translation-unit seam only. Production uses these immutable Win32
// functions; no public API can inject a device, file or I/O result.
struct IoOps {
    decltype(&DeviceIoControl) send;
    decltype(&GetOverlappedResultEx) result;
    decltype(&CancelIoEx) cancel;
};
const IoOps NativeOps{&DeviceIoControl, &GetOverlappedResultEx, &CancelIoEx};
struct IoResult {
    bool attempted = false, completed = false, unconfirmed = false;
    DWORD error = ERROR_SUCCESS;
    DWORD completionError = ERROR_IO_INCOMPLETE, cancelError = ERROR_SUCCESS;
    bool cancelRequested = false;
    Reply reply{};
};
struct Slot {
    std::mutex gate;
    std::shared_ptr<softwaredevice::OwnedSoftwareDevice> device;
    HANDLE file = INVALID_HANDLE_VALUE;
    std::unique_ptr<PendingIo> pending;
    IoOps ops = NativeOps;
    bool everOpened = false, closed = false;
    // The registry keeps this slot alive whenever an IRP or file is unconfirmed.
    // This destructor is reached only before opening or after confirmed closure.
    ~Slot() { if (pending) (void)pending.release(); }
    bool Drain(DWORD wait = DrainWaitMs) {
        if (!pending) return true;
        DWORD bytes = 0;
        const BOOL completed = ops.result(file, &pending->overlapped, &bytes, wait, FALSE);
        if (!completed && !HasOverlappedIoCompleted(&pending->overlapped)) return false;
        pending.reset(); return true;
    }
    bool CloseFile() {
        if (file == INVALID_HANDLE_VALUE) return !everOpened || closed;
        if (pending) return false;
        // CloseHandle can invoke native driver cleanup; it has no wall-clock
        // deadline guarantee. Only this original file is ever closed.
        if (!CloseHandle(file)) return false;
        file = INVALID_HANDLE_VALUE; closed = true; return true;
    }
};
IoResult Issue(Slot& slot, ULONG code, const void* input, DWORD size) {
    if (slot.pending || slot.file == INVALID_HANDLE_VALUE) Fail("CONTROL_IO_LIFETIME_REFUSED");
    auto pending = std::make_unique<PendingIo>();
    if (!input || size > pending->input.size()) Fail("CONTROL_REQUEST_SIZE_REFUSED");
    std::memcpy(pending->input.data(), input, size); slot.pending = std::move(pending);
    IoResult result; result.attempted = true;
    const BOOL sent = slot.ops.send(slot.file, code, slot.pending->input.data(), size, &slot.pending->output,
        static_cast<DWORD>(sizeof(Reply)), nullptr, &slot.pending->overlapped);
    const DWORD startError = sent ? ERROR_SUCCESS : GetLastError();
    if (!sent && startError != ERROR_IO_PENDING) {
        result.completed = true; result.error = startError ? startError : ERROR_GEN_FAILURE; result.completionError = result.error; slot.pending.reset(); return result;
    }
    if (!slot.ops.result(slot.file, &slot.pending->overlapped, &slot.pending->bytes, IoWaitMs, FALSE)) {
        result.error = GetLastError(); if (!result.error) result.error = ERROR_GEN_FAILURE;
        result.completionError = result.error;
        if (!HasOverlappedIoCompleted(&slot.pending->overlapped)) {
            // Cancellation is a request. ERROR_NOT_FOUND is not completion proof.
            result.cancelRequested = true;
            if (!slot.ops.cancel(slot.file, &slot.pending->overlapped)) result.cancelError = GetLastError();
            const BOOL drained = slot.ops.result(slot.file, &slot.pending->overlapped, &slot.pending->bytes, DrainWaitMs, FALSE);
            result.completionError = drained ? ERROR_SUCCESS : GetLastError();
            if (!drained && !HasOverlappedIoCompleted(&slot.pending->overlapped)) { result.completionError = ERROR_IO_INCOMPLETE; result.unconfirmed = true; return result; }
        }
        result.completed = true; slot.pending.reset(); return result;
    }
    result.completed = true; result.completionError = ERROR_SUCCESS;
    if (slot.pending->bytes != sizeof(Reply)) result.error = ERROR_BAD_LENGTH;
    else result.reply = slot.pending->output;
    slot.pending.reset(); return result;
}
struct DeviceKey {
    std::wstring instance;
    softwaredevice::TrustedProjectBinding binding;
};
bool SameKey(const DeviceKey& a, const DeviceKey& b) { return !_wcsicmp(a.instance.c_str(), b.instance.c_str()) && SameBinding(a.binding, b.binding); }
struct Entry {
    DeviceKey key;
    std::weak_ptr<softwaredevice::OwnedSoftwareDevice> original;
    const softwaredevice::OwnedSoftwareDevice* originalAddress = nullptr;
    std::shared_ptr<softwaredevice::OwnedSoftwareDevice> stickyDevice;
    std::shared_ptr<Slot> slot;
    bool active = false, blocked = false;
};
struct Registry { std::mutex gate; std::vector<Entry> entries; };
Registry& ProcessRegistry() {
    // Unconfirmed kernel-referenced buffers/events/file/device survive C++ static
    // teardown. Native process teardown is the final bound, never host ExitProcess.
    static auto* const registry = new Registry(); return *registry;
}
void Acquire(const DeviceKey& key, const std::shared_ptr<Slot>& slot) {
    auto& registry = ProcessRegistry(); std::lock_guard<std::mutex> lock(registry.gate);
    for (auto it = registry.entries.begin(); it != registry.entries.end();) {
        if (!it->active && !it->blocked && it->original.expired()) it = registry.entries.erase(it); else ++it;
    }
    for (auto& entry : registry.entries) {
        // Never acquire/release a last strong device reference under this global
        // mutex: its destructor can enter unbounded native SwDeviceClose.
        const bool sameOwnership = !entry.original.owner_before(slot->device) && !slot->device.owner_before(entry.original);
        const bool sameObject = sameOwnership && entry.originalAddress == slot->device.get();
        const bool sameKey = SameKey(entry.key, key);
        if (!sameObject && !sameKey) continue;
        if (!sameObject || !sameKey) Fail("CONTROL_DEVICE_CAPABILITY_CHANGED");
        if (entry.blocked) Fail("CONTROL_DEVICE_SESSION_RETIRED");
        if (entry.active) Fail("CONTROL_DEVICE_SESSION_BUSY");
        entry.original = slot->device; entry.originalAddress = slot->device.get(); entry.slot = slot; entry.active = true; return;
    }
    registry.entries.push_back({key, slot->device, slot->device.get(), {}, slot, true, false});
}
void Retain(const DeviceKey& key, const std::shared_ptr<Slot>& slot, bool blocked, bool active) {
    auto& registry = ProcessRegistry(); std::lock_guard<std::mutex> lock(registry.gate);
    for (auto& entry : registry.entries) if (SameKey(entry.key, key) && entry.slot == slot) {
        entry.blocked = entry.blocked || blocked; entry.active = active;
        if (entry.blocked) { entry.stickyDevice = slot->device; entry.slot = slot; }
        else if (!active) entry.slot.reset();
        return;
    }
    // An admitted slot must never lose its quarantine authority.
    Fail("CONTROL_REGISTRY_LIFETIME_UNCONFIRMED");
}
} // namespace internal

struct OwnedDisplayControl::Impl : internal::ProtocolState {
    std::mutex operationGate;
    std::atomic<bool> retired{false};
    std::shared_ptr<internal::Slot> slot;
    internal::DeviceKey key;
    std::wstring originalPath;
    bool registered = false;
    ControlObservation trace;
    void Block() { internal::ProtocolState::Block(); if (registered) internal::Retain(key, slot, true, true); }
    void Current() {
        if (retired.load() || !slot || !slot->device || !internal::SameBinding(key.binding, slot->device->Binding()) ||
            _wcsicmp(key.instance.c_str(), slot->device->InstanceId().c_str())) internal::Fail("CONTROL_DEVICE_RETIRED");
        const auto path = slot->device->InternalControlInterfacePath();
        if (path.empty() || (!originalPath.empty() && _wcsicmp(path.c_str(), originalPath.c_str()))) internal::Fail("CONTROL_ORIGINAL_INTERFACE_CHANGED");
    }
    ControlObservation Send(Operation operation, ULONG code, const void* input, DWORD bytes, bool mutation) {
        ControlObservation observation; observation.operation = operation;
        if (slot->pending) internal::Fail("CONTROL_IO_COMPLETION_UNCONFIRMED");
        Current();
        // Retiring can race an in-flight native request; no later request may use
        // the result as a new capability. Main retires control before bare device.
        if (retired.load()) internal::Fail("CONTROL_DEVICE_RETIRED");
        const auto io = internal::Issue(*slot, code, input, bytes);
        observation.ioAttempted = io.attempted; observation.ioCompleted = io.completed;
        observation.mutationAttempted = mutation && io.attempted; observation.completionUnconfirmed = io.unconfirmed; observation.win32Error = io.error;
        observation.completionWin32Error = io.completionError; observation.cancelRequested = io.cancelRequested; observation.cancelWin32Error = io.cancelError;
        trace = observation;
        if (io.error || io.unconfirmed) {
            Block(); if (io.unconfirmed) retired.store(true);
            observation.reason = io.unconfirmed ? "CONTROL_IO_COMPLETION_UNCONFIRMED_NO_REPLAY" : "CONTROL_IO_FAILED_OBSERVE_NO_REPLAY";
            observation.retired = retired.load(); trace = observation; return observation;
        }
        // Keep the actual returned bytes as evidence even if later owner checks
        // refuse them; never adopt a monitor from an uncertain operation.
        observation.hasReply = true; observation.reply = io.reply;
        trace = observation;
        CheckPinned(io.reply); Current();
        observation.protocolConfirmed = true;
        if (io.reply.state == State::RemovalUnconfirmed || io.reply.state == State::FileClosing || io.reply.state == State::DeviceStopping) Block();
        observation.mutationsBlocked = sticky || io.reply.state != State::Empty;
        observation.reason = "CONTROL_REPLY_OBSERVED"; lastReply = io.reply; trace = observation; return observation;
    }
    ControlObservation Query(Operation operation) {
        const Header query{sizeof(Header), ProtocolVersion}; auto observation = Send(operation, QueryCode(), &query, sizeof(query), false);
        if (!observation.protocolConfirmed) return observation;
        AcceptQuery(observation.reply);
        observation.mutationsBlocked = sticky || observation.reply.state == State::AdapterNotReady ||
            observation.reply.state == State::FileClosing || observation.reply.state == State::DeviceStopping || observation.reply.state == State::RemovalUnconfirmed;
        if (observation.reply.state == State::AdapterNotReady && !sticky) observation.reason = "CONTROL_ADAPTER_PENDING_OBSERVE_ONLY";
        trace = observation; return observation;
    }
    static ULONG QueryCode() { return reviewops::display::Query; }
    ControlObservation Execute(Operation operation) {
        trace = {}; trace.operation = operation;
        if (retired.load()) internal::Refuse("CONTROL_OWNER_RETIRED");
        if (slot->pending) internal::Fail("CONTROL_IO_LIFETIME_RETIRED");
        if (operation != Operation::Status && sticky) internal::Fail("CONTROL_MUTATIONS_PERMANENTLY_BLOCKED");
        auto preflight = Query(operation);
        if (operation == Operation::Status || !preflight.protocolConfirmed) return preflight;
        if (sticky) internal::Fail("CONTROL_MUTATIONS_PERMANENTLY_BLOCKED");
        if (operation == Operation::Create1080 || operation == Operation::Create4k) {
            if (preflight.reply.state != State::Empty || !internal::Zero(ownedMonitor.monitorId)) internal::Refuse("CONTROL_CREATE_PRECONDITION_REFUSED");
            const bool fourK = operation == Operation::Create4k;
            const CreateRequest request{{sizeof(CreateRequest), ProtocolVersion}, fourK ? 3840U : 1920U, fourK ? 2160U : 1080U, 60, 0};
            cleanEmpty = false;
            auto result = Send(operation, reviewops::display::Create, &request, sizeof(request), true);
            if (!result.protocolConfirmed) return result;
            AcceptCreate(result.reply, request.width, request.height);
            result.mutationsBlocked = false; result.reason = "CONTROL_OWNED_MONITOR_CREATED"; return result;
        }
        if (operation == Operation::Remove) {
            if (internal::Zero(ownedMonitor.monitorId) || preflight.reply.state != State::Attached) internal::Refuse("CONTROL_NO_CONFIRMED_MONITOR_TO_REMOVE");
            const RemoveRequest request{{sizeof(RemoveRequest), ProtocolVersion}, ownedMonitor.monitorId, {0, 0}};
            cleanEmpty = false;
            auto result = Send(operation, reviewops::display::Remove, &request, sizeof(request), true);
            if (!result.protocolConfirmed) return result;
            AcceptRemove(result.reply);
            result.mutationsBlocked = sticky; result.reason = "CONTROL_OWNED_MONITOR_REMOVE_ACKNOWLEDGED"; return result;
        }
        internal::Refuse("CONTROL_OPERATION_REFUSED");
    }
};
OwnedDisplayControl::OwnedDisplayControl(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
OwnedDisplayControl::~OwnedDisplayControl() { Close(); }
OwnedDisplayControl::OwnedDisplayControl(OwnedDisplayControl&&) noexcept = default;
softwaredevice::TrustedProjectBinding OwnedDisplayControl::Binding() const noexcept { return impl_ ? impl_->key.binding : softwaredevice::TrustedProjectBinding{}; }
ControlObservation OwnedDisplayControl::Perform(Operation operation) noexcept {
    ControlObservation observation; observation.operation = operation;
    if (!impl_) { observation.reason = "CONTROL_OWNER_RETIRED"; observation.retired = true; return observation; }
    try {
        std::lock_guard<std::mutex> lock(impl_->operationGate); std::lock_guard<std::mutex> io(impl_->slot->gate);
        try { return impl_->Execute(operation); }
        catch (const internal::Failure& error) {
            observation = impl_->trace;
            if (error.uncertain) { impl_->Block(); observation.protocolConfirmed = false; }
            observation.reason = error.reason; observation.win32Error = error.code;
        }
        catch (...) { observation = impl_->trace; impl_->Block(); observation.protocolConfirmed = false; observation.reason = "CONTROL_OPERATION_UNCONFIRMED"; observation.win32Error = ERROR_UNHANDLED_EXCEPTION; }
        observation.completionUnconfirmed = impl_->slot->pending != nullptr; observation.retired = impl_->retired.load();
        observation.mutationsBlocked = observation.retired || impl_->sticky || !impl_->pinned || impl_->lastReply.state == State::AdapterNotReady ||
            impl_->lastReply.state == State::RemovalUnconfirmed || impl_->lastReply.state == State::FileClosing || impl_->lastReply.state == State::DeviceStopping;
    } catch (...) { observation.reason = "CONTROL_LIFETIME_UNCONFIRMED"; observation.win32Error = ERROR_UNHANDLED_EXCEPTION; }
    return observation;
}
ControlObservation OwnedDisplayControl::Status() noexcept { return Perform(Operation::Status); }
ControlObservation OwnedDisplayControl::Create1080() noexcept { return Perform(Operation::Create1080); }
ControlObservation OwnedDisplayControl::Create4k() noexcept { return Perform(Operation::Create4k); }
ControlObservation OwnedDisplayControl::Remove() noexcept { return Perform(Operation::Remove); }
CloseObservation OwnedDisplayControl::Close() noexcept {
    CloseObservation observation;
    if (!impl_) return observation;
    impl_->retired.store(true);
    try {
        std::lock_guard<std::mutex> lock(impl_->operationGate); std::lock_guard<std::mutex> io(impl_->slot->gate);
        if (impl_->slot->everOpened && (!impl_->cleanEmpty || !internal::Zero(impl_->ownedMonitor.monitorId))) impl_->Block();
        observation.ioCompletionConfirmed = impl_->slot->Drain();
        if (!observation.ioCompletionConfirmed) impl_->Block();
        observation.fileHandleClosed = observation.ioCompletionConfirmed && impl_->slot->CloseFile();
        if (!observation.fileHandleClosed) impl_->Block();
        observation.pendingQuarantined = impl_->slot->pending != nullptr || !observation.fileHandleClosed;
        observation.stickyDeviceRetirement = impl_->sticky;
        if (impl_->registered) {
            internal::Retain(impl_->key, impl_->slot, impl_->sticky || observation.pendingQuarantined, false);
            if (!impl_->sticky && !observation.pendingQuarantined) impl_->registered = false;
        }
    } catch (...) { observation.pendingQuarantined = true; observation.stickyDeviceRetirement = true; }
    return observation;
}
ControlOpening OpenOwnedDisplayControl(std::shared_ptr<softwaredevice::OwnedSoftwareDevice> device, const softwaredevice::TrustedProjectBinding& binding) {
    ControlOpening opening;
    try {
        internal::CheckBinding(binding);
        if (!device || !internal::SameBinding(device->Binding(), binding)) internal::Fail("CONTROL_DEVICE_CAPABILITY_REFUSED");
        const auto instance = device->InstanceId();
        if (instance.empty() || instance.size() >= 512) internal::Fail("CONTROL_DEVICE_CAPABILITY_REFUSED");
        const auto path = device->InternalControlInterfacePath(); if (path.empty()) internal::Fail("CONTROL_DEVICE_INTERFACE_UNAVAILABLE");
        auto impl = std::make_unique<OwnedDisplayControl::Impl>(); impl->key = {instance, binding}; impl->originalPath = path;
        impl->slot = std::make_shared<internal::Slot>(); impl->slot->device = std::move(device);
        opening.owner = std::unique_ptr<OwnedDisplayControl>(new OwnedDisplayControl(std::move(impl)));
        auto& state = *opening.owner->impl_; std::lock_guard<std::mutex> lock(state.operationGate); std::lock_guard<std::mutex> io(state.slot->gate);
        internal::Acquire(state.key, state.slot); state.registered = true;
        state.Current(); state.slot->file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, nullptr);
        if (state.slot->file == INVALID_HANDLE_VALUE) internal::Fail("CONTROL_ORIGINAL_FILE_OPEN_FAILED", GetLastError());
        state.slot->everOpened = true; state.Current();
        const Header query{sizeof(Header), ProtocolVersion}; opening.observation = state.Send(Operation::Open, reviewops::display::Query, &query, sizeof(query), false);
        if (opening.observation.protocolConfirmed) {
            state.PinInitial(opening.observation.reply);
            opening.observation.mutationsBlocked = state.sticky || opening.observation.reply.state != State::Empty;
            opening.observation.reason = !opening.observation.mutationsBlocked ? "CONTROL_ORIGINAL_FILE_ADMITTED" : "CONTROL_OBSERVE_ONLY";
        }
    } catch (const internal::Failure& error) {
        if (opening.owner) { try { std::lock_guard<std::mutex> lock(opening.owner->impl_->operationGate); opening.observation = opening.owner->impl_->trace; } catch (...) {} }
        opening.observation.reason = error.reason; opening.observation.win32Error = error.code; opening.observation.protocolConfirmed = false;
    }
    catch (...) {
        if (opening.owner) { try { std::lock_guard<std::mutex> lock(opening.owner->impl_->operationGate); opening.observation = opening.owner->impl_->trace; } catch (...) {} }
        opening.observation.reason = "CONTROL_OPEN_UNCONFIRMED"; opening.observation.win32Error = ERROR_UNHANDLED_EXCEPTION; opening.observation.protocolConfirmed = false;
    }
    if (opening.owner && !opening.observation.protocolConfirmed) {
        try { std::lock_guard<std::mutex> lock(opening.owner->impl_->operationGate); opening.owner->impl_->Block(); } catch (...) {}
        opening.owner->Close(); opening.observation.retired = true; opening.observation.mutationsBlocked = true;
    }
    return opening;
}
} // namespace reviewops::display::control
