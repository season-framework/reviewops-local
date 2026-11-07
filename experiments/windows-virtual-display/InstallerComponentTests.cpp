// Focused units: synthetic import metadata, read-only native OS roots, and
// scripted Software Device transport with real Windows synchronization.
// No production package is manufactured and no import/device API is invoked.
#include "OwnedSoftwareDevice.cpp"
#include "PackageInstall.cpp"

#include <cstdio>
#include <functional>

namespace {
namespace installer = reviewops::display::install;
namespace import_impl = reviewops::display::install::internal;
namespace device = reviewops::display::softwaredevice;
namespace device_impl = reviewops::display::softwaredevice::internal;

struct TestFailure { const char* reason; LONG code; };
[[noreturn]] void FailTest(const char* reason, DWORD error = ERROR_SUCCESS) {
    throw TestFailure{reason, static_cast<LONG>(error)};
}
void Need(bool condition, const char* reason) { if (!condition) FailTest(reason, GetLastError()); }
bool cleanupComplete = true;
std::string observations;
void Observe(const char* key, uint64_t value) {
    std::array<char, 128> buffer{};
    std::snprintf(buffer.data(), buffer.size(), "%s\"%s\":%llu", observations.empty() ? "" : ",", key,
        static_cast<unsigned long long>(value));
    observations += buffer.data();
}
void ObserveReason(const char* key, const char* reason) {
    observations += observations.empty() ? "" : ",";
    observations += std::string("\"") + key + "\":\"" + reason + "\"";
}
template<typename Operation> void ImportRefuses(Operation operation, const char* expected) {
    try { operation(); }
    catch (const import_impl::Failure& error) {
        Need(std::strcmp(error.reason, expected) == 0, "TEST_IMPORT_REFUSAL_DIFFERENT");
        return;
    }
    FailTest("TEST_EXPECTED_IMPORT_REFUSAL_MISSING");
}

struct CopyBuffer {
    const std::wstring root = L"C:\\Windows\\INF";
    std::array<wchar_t, MAX_PATH> text{};
    DWORD required = 0;
    PWSTR component = nullptr;
    explicit CopyBuffer(const std::wstring& name = L"oem42.inf", const std::wstring& parent = L"C:\\Windows\\INF") {
        const auto path = parent + L"\\" + name;
        Need(path.size() + 1 <= text.size(), "TEST_BUFFER_FIXTURE_TOO_LONG");
        std::copy(path.begin(), path.end(), text.begin());
        required = static_cast<DWORD>(path.size() + 1);
        component = text.data() + parent.size() + 1;
    }
    import_impl::CopyOutcome Parse(BOOL success = TRUE, DWORD error = ERROR_SUCCESS) {
        return import_impl::ParseCopyOutput(success, error, text, required, component, root);
    }
};

enum class Script { Early, Delayed, FailedCallback, FailedCreate, LateOnClose, MismatchedHandle, NullId, OverlongId, ParentLifetime };
struct Scenario;
std::mutex registryGate;
std::vector<Scenario*> registry;
thread_local Scenario* activeScenario = nullptr;

device::TrustedProjectBinding Binding(DWORD seed = 1) {
    return {{seed, 0x1144, 0x4a55, {0x80, 1, 2, 3, 4, 5, 6, 7}},
            {seed + 1, 0x2244, 0x4b55, {0x80, 1, 2, 3, 4, 5, 6, 8}},
            {seed + 2, 0x3344, 0x4c55, {0x80, 1, 2, 3, 4, 5, 6, 9}}};
}
bool SameGuid(const GUID& left, const GUID& right) { return !std::memcmp(&left, &right, sizeof(left)); }
bool ExactDeviceSecurity(PSECURITY_DESCRIPTOR descriptor) {
    if (!descriptor || !IsValidSecurityDescriptor(descriptor)) return false;
    PSID owner = nullptr; BOOL defaulted = FALSE;
    if (!GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) || !owner || !IsWellKnownSid(owner, WinBuiltinAdministratorsSid)) return false;
    PACL acl = nullptr; BOOL present = FALSE;
    if (!GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) || !present || !acl || !IsValidAcl(acl) || acl->AceCount != 2) return false;
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision) || !(control & SE_DACL_PROTECTED)) return false;
    bool system = false, admins = false;
    for (DWORD index = 0; index < acl->AceCount; ++index) {
        PVOID raw = nullptr;
        if (!GetAce(acl, index, &raw)) return false;
        const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags || ace->Mask != GENERIC_ALL) return false;
        PSID sid = const_cast<DWORD*>(&ace->SidStart);
        if (IsWellKnownSid(sid, WinLocalSystemSid)) system = true;
        else if (IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) admins = true;
        else return false;
    }
    return system && admins;
}

struct Scenario {
    Script script;
    device::TrustedProjectBinding expectedBinding;
    SW_DEVICE_CREATE_CALLBACK callback = nullptr;
    PVOID context = nullptr;
    HSWDEVICE callbackOverride = nullptr;
    std::wstring instance = L"SWD\\OS-DECORATED\\callback-assigned-instance";
    std::array<wchar_t, device_impl::MaximumInstanceChars> overlong{};
    std::wstring nonce;
    std::atomic<unsigned> createCalls{0}, callbackCalls{0}, lifetimeCalls{0}, closeCalls{0};
    std::atomic<bool> liveOwned{false};
    bool argumentsValid = false, callbackBeforeReturn = false, callbackDuringClose = false, closeSawLiveContext = false;
    DWORD createThread = 0, callbackThread = 0;
    explicit Scenario(Script value, DWORD seed = 1) : script(value), expectedBinding(Binding(seed)) {
        overlong.fill(L'A');
        std::lock_guard<std::mutex> lock(registryGate);
        registry.push_back(this);
    }
    Scenario(const Scenario&) = delete;
    Scenario& operator=(const Scenario&) = delete;
    HSWDEVICE Handle() { return reinterpret_cast<HSWDEVICE>(this); }
    ~Scenario() {
        if (liveOwned.load()) cleanupComplete = false;
        std::lock_guard<std::mutex> lock(registryGate);
        registry.erase(std::remove(registry.begin(), registry.end(), this), registry.end());
    }
};
[[noreturn]] void Fatal(const char* reason) noexcept {
    std::fputs(reason, stderr); std::fputs("\n", stderr);
    ExitProcess(3);
}
Scenario& FindScenario(HSWDEVICE handle) {
    std::lock_guard<std::mutex> lock(registryGate);
    for (auto* scenario : registry) if (scenario->Handle() == handle) return *scenario;
    Fatal("TEST_UNKNOWN_SCRIPTED_HANDLE");
}
void Deliver(Scenario& scenario) {
    if (!scenario.callback || !scenario.context) Fatal("TEST_CALLBACK_CONTEXT_MISSING");
    scenario.callbackCalls.fetch_add(1);
    scenario.callbackThread = GetCurrentThreadId();
    const auto handle = scenario.callbackOverride ? scenario.callbackOverride : scenario.Handle();
    const auto result = scenario.script == Script::FailedCallback ? E_FAIL : S_OK;
    const wchar_t* instance = scenario.script == Script::NullId ? nullptr :
        scenario.script == Script::OverlongId ? scenario.overlong.data() : scenario.instance.c_str();
    scenario.callback(handle, result, scenario.context, instance);
}
HRESULT WINAPI ScriptedCreate(PCWSTR enumerator, PCWSTR parent, const SW_DEVICE_CREATE_INFO* info,
    ULONG count, const DEVPROPERTY* properties, SW_DEVICE_CREATE_CALLBACK callback, PVOID context, PHSWDEVICE output) {
    if (!activeScenario || !output) return E_INVALIDARG;
    auto& scenario = *activeScenario;
    scenario.createCalls.fetch_add(1); scenario.createThread = GetCurrentThreadId(); *output = nullptr;
    scenario.callback = callback; scenario.context = context;
    bool nonce = info && info->pszInstanceId;
    if (nonce) {
        size_t chars = 0;
        while (chars < 33 && info->pszInstanceId[chars]) ++chars;
        nonce = chars == 32;
        for (size_t index = 0; nonce && index < chars; ++index) {
            const auto c = info->pszInstanceId[index];
            nonce = (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f');
        }
        if (nonce) scenario.nonce.assign(info->pszInstanceId, chars);
    }
    scenario.argumentsValid = enumerator && parent && info && info->cbSize == sizeof(*info) &&
        !wcscmp(enumerator, device_impl::Enumerator) && !wcscmp(parent, device_impl::Parent) &&
        info->pszzHardwareIds && !wcscmp(info->pszzHardwareIds, L"ReviewOpsVirtualDisplayPrototype") &&
        info->pszzHardwareIds[std::wcslen(L"ReviewOpsVirtualDisplayPrototype") + 1] == L'\0' &&
        info->pContainerId && SameGuid(*info->pContainerId, scenario.expectedBinding.sessionId) &&
        info->CapabilityFlags == static_cast<ULONG>(SWDeviceCapabilitiesRemovable | SWDeviceCapabilitiesDriverRequired) &&
        !count && !properties && callback && context && nonce && ExactDeviceSecurity(info->pSecurityDescriptor);
    if (!scenario.argumentsValid) return E_INVALIDARG;
    if (scenario.script == Script::FailedCreate) return E_ACCESSDENIED;
    *output = scenario.Handle(); scenario.liveOwned.store(true);
    if (scenario.script != Script::Delayed && scenario.script != Script::LateOnClose) {
        scenario.callbackBeforeReturn = true; Deliver(scenario);
    }
    return S_OK;
}
HRESULT WINAPI ScriptedLifetime(HSWDEVICE handle, PSW_DEVICE_LIFETIME value) {
    auto& scenario = FindScenario(handle); scenario.lifetimeCalls.fetch_add(1);
    if (!value || !scenario.callbackCalls.load()) return E_UNEXPECTED;
    *value = scenario.script == Script::ParentLifetime ? SWDeviceLifetimeParentPresent : SWDeviceLifetimeHandle;
    return S_OK;
}
VOID WINAPI ScriptedClose(HSWDEVICE handle) {
    auto& scenario = FindScenario(handle);
    if (scenario.closeCalls.fetch_add(1) || !scenario.liveOwned.exchange(false)) Fatal("TEST_SCRIPTED_DOUBLE_CLOSE");
    auto* state = static_cast<device_impl::EnumerationState*>(scenario.context);
    DWORD flags = 0;
    scenario.closeSawLiveContext = state && GetHandleInformation(state->event.value, &flags) &&
        state->OriginalHandle() == nullptr;
    if (!scenario.closeSawLiveContext) Fatal("TEST_CLOSE_CONTEXT_NOT_RETAINED");
    if (scenario.script == Script::LateOnClose && !scenario.callbackCalls.load()) {
        scenario.callbackDuringClose = true; Deliver(scenario);
    }
}
const device_impl::EnumerationOps ScriptedOps{&ScriptedCreate, &ScriptedLifetime, &ScriptedClose};

struct TestState : device_impl::EnumerationState {
    ~TestState() {
        Close();
        for (auto* handle : {&event.value, &returnedEvent.value}) {
            if (*handle && *handle != INVALID_HANDLE_VALUE && !CloseHandle(*handle)) cleanupComplete = false;
            *handle = nullptr;
        }
    }
};
struct StartResult { const char* reason = nullptr; LONG nativeCode = ERROR_SUCCESS; };
StartResult Invoke(Scenario& scenario, device_impl::EnumerationState& state, DWORD wait = 1000) {
    activeScenario = &scenario;
    StartResult result;
    try { device_impl::StartEnumeration(state, ScriptedOps, scenario.expectedBinding, wait); }
    catch (const device_impl::Failure& failure) { result.reason = failure.reason; result.nativeCode = failure.code; }
    catch (...) { activeScenario = nullptr; throw; }
    activeScenario = nullptr;
    return result;
}
void Expected(const StartResult& value, const char* reason) {
    Need(value.reason && !std::strcmp(value.reason, reason), "TEST_DEVICE_REFUSAL_DIFFERENT");
    ObserveReason("refusal", value.reason);
}
void Success(const StartResult& value, Scenario& scenario, device_impl::EnumerationState& state) {
    Need(!value.reason && scenario.argumentsValid && state.enumerated && state.lifetimeVerified, "TEST_ENUMERATION_NOT_CONFIRMED");
    Need(state.instance == scenario.instance && state.instance.find(scenario.nonce) == std::wstring::npos, "TEST_CALLBACK_ID_NOT_AUTHORITATIVE");
    Need(state.OriginalHandle() == scenario.Handle() && scenario.createCalls.load() == 1 &&
        scenario.callbackCalls.load() == 1 && scenario.lifetimeCalls.load() == 1, "TEST_ENUMERATION_COUNTS_DIFFERENT");
}
void Retire(Scenario& scenario, device_impl::EnumerationState& state) {
    const auto result = state.Close();
    Need(result.handleClosed && result.callbacksDrained && !result.removalConfirmed &&
        scenario.closeCalls.load() == 1 && !scenario.liveOwned.load(), "TEST_OWNED_CLOSE_UNCONFIRMED");
    state.Close();
    Need(scenario.closeCalls.load() == 1, "TEST_CLOSE_REPLAYED");
}
struct AsyncStart {
    Scenario& scenario;
    device_impl::EnumerationState& state;
    DWORD wait;
    HANDLE thread = nullptr;
    StartResult result;
    bool unexpected = false;
    static DWORD WINAPI Run(PVOID raw) noexcept {
        auto& self = *static_cast<AsyncStart*>(raw);
        try { self.result = Invoke(self.scenario, self.state, self.wait); }
        catch (...) { self.unexpected = true; }
        return 0;
    }
    AsyncStart(Scenario& input, device_impl::EnumerationState& owner, DWORD timeout) : scenario(input), state(owner), wait(timeout) {
        thread = CreateThread(nullptr, 0, &Run, this, 0, nullptr);
        Need(thread != nullptr, "TEST_THREAD_START_FAILED");
    }
    void Join() {
        if (WaitForSingleObject(thread, 4000) != WAIT_OBJECT_0) Fatal("TEST_OWNED_THREAD_DRAIN_UNCONFIRMED");
        Need(!unexpected, "TEST_WORKER_UNHANDLED_EXCEPTION");
    }
    ~AsyncStart() {
        if (thread) {
            if (WaitForSingleObject(thread, 4000) != WAIT_OBJECT_0) Fatal("TEST_OWNED_THREAD_DRAIN_UNCONFIRMED");
            if (!CloseHandle(thread)) cleanupComplete = false;
        }
    }
};
struct Case { const char* name; const char* operation; const char* scope; std::function<void()> run; };
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || wcscmp(argv[1], L"--self-test")) {
        std::puts("{\"type\":\"summary\",\"version\":1,\"status\":\"failed\",\"reason\":\"INVALID_ARGUMENT\",\"actualSetupCopyCalls\":0,\"actualSoftwareDevicesCreated\":0,\"positiveSignedProductionInstallTested\":false,\"driverInstalled\":false,\"displayChanged\":false}");
        return 2;
    }
    const std::array<Case, 12> cases = {{
        {"import-output-classification", "Parse scripted SetupCopyOEMInf result buffers", "Metadata only; no import call or InstalledPackage is constructed", [] {
            CopyBuffer imported; const auto first = imported.Parse();
            Need(first.disposition == installer::ImportDisposition::Imported && first.publishedName == L"oem42.inf" &&
                first.publishedPath == L"C:\\Windows\\INF\\oem42.inf", "TEST_IMPORTED_METADATA_DIFFERENT");
            CopyBuffer existing(L"OEM42.INF"); const auto second = existing.Parse(FALSE, ERROR_FILE_EXISTS);
            Need(second.disposition == installer::ImportDisposition::AlreadyPresent && second.publishedName == L"OEM42.INF", "TEST_EXISTING_METADATA_DIFFERENT");
            Need(import_impl::ClassifyCopyOutcome(FALSE, ERROR_ACCESS_DENIED) == installer::ImportDisposition::Uncertain, "TEST_UNCERTAIN_OUTCOME_DIFFERENT");
            CopyBuffer denied; ImportRefuses([&] { denied.Parse(FALSE, ERROR_ACCESS_DENIED); }, "IMPORT_COPY_UNCERTAIN");
            Observe("metadataOutcomesChecked", 3); Observe("actualSetupCopyCalls", 0);
        }},
        {"import-output-refusals", "Reject malformed synthetic path/size/component buffers", "Metadata guards only; no OS installation or trusted receipt is produced", [] {
            uint64_t refused = 0;
            for (DWORD size : {DWORD{0}, DWORD{1}, DWORD{MAX_PATH + 1}}) {
                CopyBuffer value; value.required = size;
                ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused;
            }
            { CopyBuffer value; --value.required; ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            { CopyBuffer value; value.component = nullptr; ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            { CopyBuffer value; value.component = value.text.data() + value.text.size(); ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            { CopyBuffer value; value.component = reinterpret_cast<PWSTR>(reinterpret_cast<uintptr_t>(value.text.data()) + 1); ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            { CopyBuffer value; value.component = value.text.data() + 1; ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            { CopyBuffer value; value.text.fill(L'A'); ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            for (const auto* name : {L"oem.inf", L"oem-1.inf", L"oem42.cat", L"oem42.inf:ads", L"..\\oem42.inf"}) {
                CopyBuffer value(name); ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused;
            }
            { CopyBuffer value(L"oem42.inf", L"C:\\Temp\\INF"); ImportRefuses([&] { value.Parse(); }, "IMPORT_OUTPUT_REFUSED"); ++refused; }
            Observe("malformedInputsRefused", refused); Observe("actualSetupCopyCalls", 0);
        }},
        {"native-system-roots-readonly", "OpenSystemRoots plus original-handle Recheck", "Actual native Windows OS-root identity/ACL reads only; no package or device is created", [] {
            auto roots = import_impl::OpenSystemRoots();
            Need(!roots.directories.empty() && roots.infRootDOS.size() > 3 && roots.repositoryDOS.size() > 3, "TEST_SYSTEM_ROOTS_MISSING");
            Need(roots.boundInf.rfind(L"\\\\?\\Volume{", 0) == 0 && roots.boundRepository.rfind(L"\\\\?\\Volume{", 0) == 0, "TEST_SYSTEM_ROOTS_NOT_BOUND");
            for (const auto& directory : roots.directories) {
                Need(directory.directory && directory.handle.value != INVALID_HANDLE_VALUE &&
                    directory.path.rfind(L"\\\\?\\Volume{", 0) == 0, "TEST_SYSTEM_ROOT_HANDLE_DIFFERENT");
                import_impl::Recheck(directory);
            }
            Observe("originalDirectoriesRechecked", roots.directories.size()); Observe("actualSetupCopyCalls", 0);
            for (auto& directory : roots.directories) {
                const BOOL closed = CloseHandle(directory.handle.value);
                directory.handle.value = INVALID_HANDLE_VALUE;
                Need(closed != FALSE, "TEST_ROOT_HANDLE_CLOSE_UNCONFIRMED");
            }
            Observe("originalDirectoryHandlesClosed", roots.directories.size());
        }},
        {"callback-before-create-return", "Scripted synchronous callback before Create returns", "Private enumeration engine with real event storage; no native software device", [] {
            Scenario scenario(Script::Early); TestState state;
            Success(Invoke(scenario, state), scenario, state);
            Need(scenario.callbackBeforeReturn, "TEST_EARLY_CALLBACK_NOT_EXERCISED");
            Retire(scenario, state);
            Observe("callbackBeforeReturn", 1); Observe("scriptedCreateCalls", scenario.createCalls.load()); Observe("scriptedCloseCalls", scenario.closeCalls.load());
        }},
        {"callback-after-create-return", "Release callback only after the returned-handle event", "Actual Windows worker/event ordering with scripted transport; no OS device", [] {
            Scenario scenario(Script::Delayed); TestState state;
            AsyncStart worker(scenario, state, 3000);
            Need(WaitForSingleObject(state.returnedEvent.value, 2000) == WAIT_OBJECT_0, "TEST_CREATE_RETURN_NOT_OBSERVED");
            Need(state.OriginalHandle() == scenario.Handle() && scenario.callbackCalls.load() == 0, "TEST_CALLBACK_ALREADY_DELIVERED");
            Deliver(scenario); worker.Join(); Success(worker.result, scenario, state);
            Need(scenario.createThread != scenario.callbackThread, "TEST_CALLBACK_THREAD_NOT_DISTINCT");
            Retire(scenario, state);
            Observe("returnedHandleObservedBeforeCallback", 1); Observe("createAndCallbackThreadsDiffer", 1); Observe("scriptedCloseCalls", scenario.closeCalls.load());
        }},
        {"callback-failure-closes-owner", "Scripted callback reports enumeration failure", "Original returned handle is closed once; registry enumeration is not readiness", [] {
            Scenario scenario(Script::FailedCallback); TestState state;
            Expected(Invoke(scenario, state), "DEVICE_ENUMERATION_FAILED");
            Need(!state.enumerated && !state.OriginalHandle() && scenario.closeCalls.load() == 1 &&
                scenario.lifetimeCalls.load() == 0 && scenario.closeSawLiveContext, "TEST_FAILED_CALLBACK_SCOPE_DIFFERENT");
            Observe("scriptedCloseCalls", scenario.closeCalls.load()); Observe("lifetimeCallsBeforeSuccess", scenario.lifetimeCalls.load());
        }},
        {"create-failure-no-replay", "Scripted Create fails before returning a handle", "No handle is adopted or closed, and the same attempt cannot create again", [] {
            Scenario scenario(Script::FailedCreate); TestState state;
            Expected(Invoke(scenario, state), "DEVICE_CREATE_FAILED");
            const auto replay = Invoke(scenario, state);
            Need(replay.reason && !std::strcmp(replay.reason, "DEVICE_CREATE_REPLAY_REFUSED"), "TEST_CREATE_REPLAY_NOT_REFUSED");
            Need(scenario.createCalls.load() == 1 && scenario.closeCalls.load() == 0 && scenario.callbackCalls.load() == 0 &&
                !state.enumerated && !state.OriginalHandle(), "TEST_FAILED_CREATE_SCOPE_DIFFERENT");
            Observe("scriptedCreateCalls", scenario.createCalls.load()); Observe("scriptedCloseCalls", scenario.closeCalls.load()); Observe("automaticReplayCalls", 0);
        }},
        {"timeout-drains-late-callback", "Timeout then scripted Close delivers the pending callback synchronously", "Real wait and live context prove close/drain ordering, not OS removal or latency", [] {
            Scenario scenario(Script::LateOnClose); TestState state;
            AsyncStart worker(scenario, state, 20); worker.Join();
            Expected(worker.result, "DEVICE_CREATE_TIMEOUT");
            const auto callback = state.ReadCallback(); const auto close = state.Close();
            Need(callback.received && scenario.callbackDuringClose && scenario.closeSawLiveContext &&
                scenario.closeCalls.load() == 1 && !state.enumerated && !close.removalConfirmed &&
                !close.unplugRequested, "TEST_TIMEOUT_DRAIN_DIFFERENT");
            Observe("lateCallbackDeliveredDuringClose", 1); Observe("scriptedCloseCalls", scenario.closeCalls.load()); Observe("removalConfirmed", 0);
        }},
        {"callback-handle-mismatch-refused", "Callback names a different scripted handle than Create returned", "Only the original returned handle is retired; the foreign handle is untouched", [] {
            Scenario foreign(Script::Early, 20); Scenario scenario(Script::MismatchedHandle);
            scenario.callbackOverride = foreign.Handle(); TestState state;
            Expected(Invoke(scenario, state), "DEVICE_CALLBACK_BINDING_REFUSED");
            Need(scenario.closeCalls.load() == 1 && foreign.closeCalls.load() == 0 &&
                !state.enumerated && !state.OriginalHandle(), "TEST_FOREIGN_HANDLE_SCOPE_CHANGED");
            Observe("originalScriptedHandleClosed", 1); Observe("foreignScriptedHandleClosed", foreign.closeCalls.load());
        }},
        {"callback-id-bounds-refused", "Callbacks supply null or nonterminated bounded instance buffers", "No guessed or truncated instance ID is admitted", [] {
            uint64_t refused = 0;
            for (const auto script : {Script::NullId, Script::OverlongId}) {
                Scenario scenario(script); TestState state;
                Expected(Invoke(scenario, state), "DEVICE_INSTANCE_ID_REFUSED");
                Need(scenario.closeCalls.load() == 1 && !state.enumerated && state.instance.empty(), "TEST_BAD_INSTANCE_ADMITTED"); ++refused;
            }
            Observe("invalidIdentitiesRefused", refused); Observe("callbackBufferBound", device_impl::MaximumInstanceChars);
        }},
        {"persistent-lifetime-refused", "Scripted lifetime query reports ParentPresent", "Reject persistent lifetime; handle closure cannot certify unplugging or removal", [] {
            Scenario scenario(Script::ParentLifetime); TestState state;
            Expected(Invoke(scenario, state), "DEVICE_PERSISTENT_LIFETIME_REFUSED"); const auto close = state.Close();
            Need(!state.lifetimeVerified && !state.enumerated && scenario.closeCalls.load() == 1 &&
                close.handleClosed && close.callbacksDrained && !close.unplugRequested && !close.removalConfirmed, "TEST_PERSISTENT_CLOSE_OVERCLAIMED");
            Observe("scriptedCloseCalls", scenario.closeCalls.load()); Observe("unplugRequested", 0); Observe("removalConfirmed", 0);
        }},
        {"owner-close-isolation", "Create two independent scripted owners and close A before B", "A retirement preserves B original handle, callback identity and enumeration state", [] {
            Scenario first(Script::Early, 30); Scenario second(Script::Early, 40);
            TestState a, b;
            Success(Invoke(first, a), first, a); Success(Invoke(second, b), second, b);
            Need(first.nonce != second.nonce, "TEST_INSTANCE_NONCE_REUSED");
            Retire(first, a);
            Need(b.enumerated && b.OriginalHandle() == second.Handle() && second.closeCalls.load() == 0 &&
                b.instance == second.instance && second.liveOwned.load(), "TEST_SIBLING_OWNER_CHANGED");
            Observe("siblingPreservedAfterFirstClose", 1); Retire(second, b);
            Observe("firstCloseCalls", first.closeCalls.load()); Observe("secondCloseCalls", second.closeCalls.load());
        }}
    }};
    size_t passed = 0, failed = 0;
    for (const auto& test : cases) {
        bool ok = true; const char* reason = "EXPECTED_UNIT_OBSERVATIONS"; LONG nativeCode = ERROR_SUCCESS;
        const auto started = GetTickCount64(); observations.clear();
        try { test.run(); }
        catch (const TestFailure& error) { ok = false; cleanupComplete = false; reason = error.reason; nativeCode = error.code; }
        catch (const import_impl::Failure& error) { ok = false; cleanupComplete = false; reason = error.reason; nativeCode = error.code; }
        catch (const device_impl::Failure& error) { ok = false; cleanupComplete = false; reason = error.reason; nativeCode = error.code; }
        catch (...) { ok = false; cleanupComplete = false; reason = "TEST_UNHANDLED_FAILURE"; nativeCode = ERROR_UNHANDLED_EXCEPTION; }
        {
            std::lock_guard<std::mutex> lock(registryGate);
            if (!registry.empty()) { cleanupComplete = false; ok = false; reason = "TEST_SCRIPTED_OWNERS_UNDRAINED"; }
        }
        if (ok) ++passed; else ++failed;
        std::printf("{\"type\":\"case\",\"name\":\"%s\",\"status\":\"%s\",\"operation\":\"%s\",\"scope\":\"%s\",\"reason\":\"%s\",\"nativeCode\":%ld,\"observations\":{%s},\"elapsedMs\":%llu}\n",
            test.name, ok ? "passed" : "failed", test.operation, test.scope, reason, nativeCode, observations.c_str(),
            static_cast<unsigned long long>(GetTickCount64() - started));
        std::fflush(stdout);
    }
    const bool success = failed == 0 && cleanupComplete;
    std::printf("{\"type\":\"summary\",\"version\":1,\"status\":\"%s\",\"counts\":{\"passed\":%zu,\"failed\":%zu,\"total\":%zu},\"cleanupComplete\":%s,\"actualSetupCopyCalls\":0,\"actualSoftwareDevicesCreated\":0,\"positiveSignedProductionInstallTested\":false,\"driverInstalled\":false,\"displayChanged\":false,\"scope\":\"Two metadata groups, one actual read-only OS-root qualification and nine scripted enumeration ownership scenarios; no signed package or device activation\"}\n",
        success ? "passed-installer-component-units-only" : "failed", passed, failed, cases.size(), cleanupComplete ? "true" : "false");
    return success ? 0 : 1;
}
