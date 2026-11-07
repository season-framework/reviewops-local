#include "OwnedSoftwareDevice.h"
#include "ControlProtocol.h"

#include <initguid.h>
#include <devpkey.h>
#include <cfgmgr32.h>
#include <swdevice.h>
#include <setupapi.h>
#include <newdev.h>
#include <bcrypt.h>
#include <sddl.h>
#include <array>
#include <atomic>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <utility>
#include <vector>

namespace reviewops::display::softwaredevice {
namespace internal {
constexpr DWORD CreationWaitMs = 10000;
constexpr size_t MaximumInstanceChars = 512;
constexpr wchar_t Enumerator[] = L"ReviewOpsProjectDisplay";
constexpr wchar_t Parent[] = L"HTREE\\ROOT\\0";
constexpr wchar_t HardwareIds[] = L"ReviewOpsVirtualDisplayPrototype\0";
constexpr GUID DisplayClass = {0x4d36e968, 0xe325, 0x11ce, {0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}};
struct Failure { const char* reason; LONG code; };
[[noreturn]] void Fail(const char* reason, LONG code = ERROR_SUCCESS) { throw Failure{reason, code}; }
void Check(BOOL ok, const char* reason) { if (!ok) Fail(reason, static_cast<LONG>(GetLastError())); }
bool Same(const GUID& a, const GUID& b) { return !std::memcmp(&a, &b, sizeof(GUID)); }
bool Zero(const GUID& a) { const GUID zero{}; return Same(a, zero); }
void CheckBinding(const TrustedProjectBinding& binding) {
    if (Zero(binding.projectId) || Zero(binding.projectBirth) || Zero(binding.sessionId) ||
        Same(binding.projectId, binding.projectBirth) || Same(binding.projectId, binding.sessionId) ||
        Same(binding.projectBirth, binding.sessionId)) Fail("DEVICE_PROJECT_BINDING_REFUSED");
}
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE handle = nullptr) : value(handle) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
void RequireElevated() {
    HANDLE thread = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) { CloseHandle(thread); Fail("DEVICE_IMPERSONATION_REFUSED"); }
    const DWORD error = GetLastError();
    if (error != ERROR_NO_TOKEN) Fail("DEVICE_TOKEN_REFUSED", static_cast<LONG>(error));
    HANDLE raw = nullptr; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "DEVICE_TOKEN_REFUSED"); Handle token(raw);
    TOKEN_ELEVATION elevation{}; DWORD count = 0;
    Check(GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &count), "DEVICE_TOKEN_REFUSED");
    std::array<BYTE, SECURITY_MAX_SID_SIZE> sid{}; DWORD bytes = static_cast<DWORD>(sid.size());
    Check(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, sid.data(), &bytes), "DEVICE_TOKEN_REFUSED");
    BOOL member = FALSE; Check(CheckTokenMembership(nullptr, sid.data(), &member), "DEVICE_TOKEN_REFUSED");
    if (!elevation.TokenIsElevated || !member) Fail("DEVICE_ELEVATION_REQUIRED");
}

// Private test seam. Production always supplies these exact native functions;
// tests can include this translation unit without minting an installed package.
struct EnumerationOps {
    decltype(&SwDeviceCreate) create;
    decltype(&SwDeviceGetLifetime) lifetime;
    decltype(&SwDeviceClose) close;
};
const EnumerationOps NativeOps{&SwDeviceCreate, &SwDeviceGetLifetime, &SwDeviceClose};
struct CallbackRecord {
    bool received = false, validId = false, repeated = false;
    HSWDEVICE handle = nullptr;
    HRESULT result = E_PENDING;
    std::array<wchar_t, MaximumInstanceChars> instance{};
};
struct EnumerationState {
    SRWLOCK callbackLock = SRWLOCK_INIT;
    CallbackRecord callback;
    Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    Handle returnedEvent{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    HSWDEVICE original = nullptr;
    EnumerationOps ops{};
    bool attempted = false, lifetimeVerified = false;
    std::atomic<bool> enumerated{false};
    bool closeIssued = false, closeReturned = false;
    TrustedProjectBinding binding{};
    std::wstring instance;
    EnumerationState() { Check(event.value != nullptr && returnedEvent.value != nullptr, "DEVICE_EVENT_FAILED"); }
    EnumerationState(const EnumerationState&) = delete;
    EnumerationState& operator=(const EnumerationState&) = delete;
    CallbackRecord ReadCallback() {
        AcquireSRWLockShared(&callbackLock); const auto value = callback; ReleaseSRWLockShared(&callbackLock); return value;
    }
    HSWDEVICE OriginalHandle() {
        AcquireSRWLockShared(&callbackLock); const auto value = original; ReleaseSRWLockShared(&callbackLock); return value;
    }
    CloseObservation Close() noexcept {
        AcquireSRWLockExclusive(&callbackLock); const auto handle = std::exchange(original, nullptr); ReleaseSRWLockExclusive(&callbackLock);
        if (handle) {
            closeIssued = true;
            // No callback lock is held. The native close drains callbacks and
            // in-progress Software Device API calls, but has no OS time bound.
            ops.close(handle); closeReturned = true;
        }
        enumerated = false;
        return {closeReturned, closeReturned, closeIssued && lifetimeVerified, false};
    }
    ~EnumerationState() { Close(); }
};
void CALLBACK EnumerationCallback(HSWDEVICE handle, HRESULT result, PVOID context, PCWSTR instance) noexcept {
    auto& state = *static_cast<EnumerationState*>(context);
    AcquireSRWLockExclusive(&state.callbackLock);
    if (state.callback.received) state.callback.repeated = true;
    else {
        state.callback.received = true; state.callback.handle = handle; state.callback.result = result;
        if (instance) {
            size_t length = 0;
            while (length < state.callback.instance.size() && instance[length]) {
                const wchar_t c = instance[length];
                if (c < 0x20 || c == 0x7f) break;
                state.callback.instance[length++] = c;
            }
            state.callback.validId = length > 0 && length < state.callback.instance.size() && instance[length] == L'\0';
        }
    }
    ReleaseSRWLockExclusive(&state.callbackLock);
    (void)SetEvent(state.event.value);
}
void StartEnumeration(EnumerationState& state, const EnumerationOps& ops, const TrustedProjectBinding& binding, DWORD waitMs) {
    CheckBinding(binding);
    if (state.attempted || !ops.create || !ops.close || !ops.lifetime || !waitMs || waitMs > CreationWaitMs)
        Fail("DEVICE_CREATE_REPLAY_REFUSED");
    state.binding = binding; state.ops = ops; state.attempted = true;
    // All callback storage and the event already exist before the native call.
    std::array<BYTE, 16> random{};
    const NTSTATUS generated = BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (generated < 0) Fail("DEVICE_RANDOM_FAILED", generated);
    std::array<wchar_t, 33> nonce{}; constexpr wchar_t hex[] = L"0123456789abcdef";
    for (size_t i = 0; i < random.size(); ++i) { nonce[i * 2] = hex[random[i] >> 4]; nonce[i * 2 + 1] = hex[random[i] & 15]; }
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"O:BAG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1,
        &descriptor, nullptr), "DEVICE_SECURITY_REFUSED");
    struct Descriptor { PSECURITY_DESCRIPTOR value; ~Descriptor() { LocalFree(value); } } security{descriptor};
    SW_DEVICE_CREATE_INFO info{}; info.cbSize = sizeof(info); info.pszInstanceId = nonce.data();
    info.pszzHardwareIds = HardwareIds; info.pContainerId = &binding.sessionId;
    info.CapabilityFlags = SWDeviceCapabilitiesRemovable | SWDeviceCapabilitiesDriverRequired;
    info.pszDeviceDescription = L"ReviewOps project-owned virtual display"; info.pSecurityDescriptor = descriptor;
    HSWDEVICE returned = nullptr;
    const HRESULT started = ops.create(Enumerator, Parent, &info, 0, nullptr, &EnumerationCallback, &state, &returned);
    AcquireSRWLockExclusive(&state.callbackLock); state.original = returned; ReleaseSRWLockExclusive(&state.callbackLock);
    (void)SetEvent(state.returnedEvent.value);
    try {
        if (FAILED(started)) Fail("DEVICE_CREATE_FAILED", started);
        if (!state.original) Fail("DEVICE_CREATE_HANDLE_REFUSED");
        const DWORD waited = WaitForSingleObject(state.event.value, waitMs);
        if (waited != WAIT_OBJECT_0) Fail(waited == WAIT_TIMEOUT ? "DEVICE_CREATE_TIMEOUT" : "DEVICE_CREATE_WAIT_FAILED",
            static_cast<LONG>(waited == WAIT_FAILED ? GetLastError() : waited));
        const auto callback = state.ReadCallback();
        if (!callback.received || callback.repeated || callback.handle != state.original) Fail("DEVICE_CALLBACK_BINDING_REFUSED");
        if (FAILED(callback.result)) Fail("DEVICE_ENUMERATION_FAILED", callback.result);
        if (!callback.validId) Fail("DEVICE_INSTANCE_ID_REFUSED");
        SW_DEVICE_LIFETIME lifetime{};
        const HRESULT status = ops.lifetime(state.original, &lifetime);
        if (FAILED(status)) Fail("DEVICE_LIFETIME_UNCONFIRMED", status);
        if (lifetime != SWDeviceLifetimeHandle) Fail("DEVICE_PERSISTENT_LIFETIME_REFUSED");
        state.lifetimeVerified = true;
        state.instance.assign(callback.instance.data()); state.enumerated = true;
    } catch (...) { state.Close(); throw; }
}

struct DeviceInfo {
    HDEVINFO set = INVALID_HANDLE_VALUE;
    SP_DEVINFO_DATA device{};
    bool driverList = false;
    explicit DeviceInfo(const std::wstring& instance) {
        device.cbSize = sizeof(device); set = SetupDiCreateDeviceInfoList(nullptr, nullptr);
        if (set == INVALID_HANDLE_VALUE) Fail("DEVICE_INFO_FAILED", static_cast<LONG>(GetLastError()));
        if (!SetupDiOpenDeviceInfoW(set, instance.c_str(), nullptr, 0, &device)) {
            const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(set); set = INVALID_HANDLE_VALUE;
            Fail("OWNED_DEVICE_UNAVAILABLE", static_cast<LONG>(error));
        }
    }
    ~DeviceInfo() {
        if (set != INVALID_HANDLE_VALUE) { if (driverList) SetupDiDestroyDriverInfoList(set, &device, SPDIT_COMPATDRIVER); SetupDiDestroyDeviceInfoList(set); }
    }
    DeviceInfo(const DeviceInfo&) = delete;
    DeviceInfo& operator=(const DeviceInfo&) = delete;
};
void CheckInstance(DeviceInfo& info, const std::wstring& expected) {
    std::array<wchar_t, MaximumInstanceChars> instance{}; DWORD size = 0;
    Check(SetupDiGetDeviceInstanceIdW(info.set, &info.device, instance.data(), static_cast<DWORD>(instance.size()), &size), "DEVICE_IDENTITY_UNCONFIRMED");
    if (size < 2 || size > instance.size() || instance[size - 1] || _wcsicmp(instance.data(), expected.c_str())) Fail("DEVICE_IDENTITY_CHANGED");
}
std::wstring StringProperty(DeviceInfo& info, const DEVPROPKEY& key, bool absentAllowed = false) {
    std::array<wchar_t, MaximumInstanceChars> value{}; DEVPROPTYPE type = 0; DWORD bytes = 0;
    if (!SetupDiGetDevicePropertyW(info.set, &info.device, &key, &type, reinterpret_cast<PBYTE>(value.data()),
        static_cast<DWORD>(sizeof(value)), &bytes, 0)) {
        const DWORD error = GetLastError(); if (absentAllowed && error == ERROR_NOT_FOUND) return {};
        Fail("DEVICE_PROPERTY_UNCONFIRMED", static_cast<LONG>(error));
    }
    if (type != DEVPROP_TYPE_STRING || bytes < sizeof(wchar_t) || bytes > sizeof(value) || bytes % sizeof(wchar_t) || value[bytes / sizeof(wchar_t) - 1])
        Fail("DEVICE_PROPERTY_REFUSED");
    const auto count = bytes / sizeof(wchar_t) - 1;
    for (size_t i = 0; i < count; ++i) if (!value[i] || value[i] < 0x20 || value[i] == 0x7f) Fail("DEVICE_PROPERTY_REFUSED");
    return std::wstring(value.data(), count);
}
GUID DeviceClass(DeviceInfo& info) {
    GUID value{}; DEVPROPTYPE type = 0; DWORD bytes = 0;
    Check(SetupDiGetDevicePropertyW(info.set, &info.device, &DEVPKEY_Device_ClassGuid, &type, reinterpret_cast<PBYTE>(&value), sizeof(value), &bytes, 0), "DEVICE_CLASS_UNCONFIRMED");
    if (type != DEVPROP_TYPE_GUID || bytes != sizeof(value)) Fail("DEVICE_CLASS_REFUSED");
    return value;
}
bool OemName(const std::wstring& name) {
    if (name.size() < 8 || name.size() > 32 || _wcsnicmp(name.c_str(), L"oem", 3) || _wcsicmp(name.c_str() + name.size() - 4, L".inf")) return false;
    for (size_t i = 3; i < name.size() - 4; ++i) if (name[i] < L'0' || name[i] > L'9') return false;
    return true;
}
std::wstring PublishedName(PCWSTR inf) {
    std::array<wchar_t, MAX_PATH> path{}; DWORD required = 0;
    Check(SetupGetInfPublishedNameW(inf, path.data(), static_cast<DWORD>(path.size()), &required), "SELECTED_DRIVER_UNCONFIRMED");
    if (!required || required > path.size() || path[required - 1]) Fail("SELECTED_DRIVER_REFUSED");
    const std::wstring full(path.data()); const auto split = full.find_last_of(L"\\");
    const auto name = split == std::wstring::npos ? full : full.substr(split + 1);
    if (!OemName(name)) Fail("SELECTED_DRIVER_REFUSED"); return name;
}
SP_DRVINFO_DATA_W ExactDriver(DeviceInfo& info, const install::InstalledPackage& package) {
    const auto expected = package.PublishedInfName(); const auto path = package.InternalDriverStoreInfPath();
    if (!OemName(expected) || path.empty() || path.size() >= MAX_PATH) Fail("INSTALLED_PACKAGE_PATH_REFUSED");
    SP_DEVINSTALL_PARAMS_W parameters{}; parameters.cbSize = sizeof(parameters);
    Check(SetupDiGetDeviceInstallParamsW(info.set, &info.device, &parameters), "DRIVER_SELECTION_FAILED");
    parameters.Flags |= DI_ENUMSINGLEINF | DI_QUIETINSTALL;
    parameters.FlagsEx &= ~DI_FLAGSEX_APPENDDRIVERLIST;
    if (wcscpy_s(parameters.DriverPath, path.c_str())) Fail("INSTALLED_PACKAGE_PATH_REFUSED");
    Check(SetupDiSetDeviceInstallParamsW(info.set, &info.device, &parameters), "DRIVER_SELECTION_FAILED");
    Check(SetupDiBuildDriverInfoList(info.set, &info.device, SPDIT_COMPATDRIVER), "DRIVER_SELECTION_FAILED"); info.driverList = true;
    SP_DRVINFO_DATA_W selected{}; size_t matches = 0;
    for (DWORD index = 0; index < 32; ++index) {
        SP_DRVINFO_DATA_W candidate{}; candidate.cbSize = sizeof(candidate);
        if (!SetupDiEnumDriverInfoW(info.set, &info.device, SPDIT_COMPATDRIVER, index, &candidate)) {
            const DWORD error = GetLastError(); if (error == ERROR_NO_MORE_ITEMS) break;
            Fail("DRIVER_SELECTION_FAILED", static_cast<LONG>(error));
        }
        DWORD bytes = 0;
        if (SetupDiGetDriverInfoDetailW(info.set, &info.device, &candidate, nullptr, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
            bytes < sizeof(SP_DRVINFO_DETAIL_DATA_W) || bytes > 65536) Fail("DRIVER_DETAIL_REFUSED");
        std::vector<DWORD> storage((bytes + sizeof(DWORD) - 1) / sizeof(DWORD));
        auto* detail = reinterpret_cast<SP_DRVINFO_DETAIL_DATA_W*>(storage.data()); detail->cbSize = sizeof(*detail);
        Check(SetupDiGetDriverInfoDetailW(info.set, &info.device, &candidate, detail, bytes, nullptr), "DRIVER_DETAIL_REFUSED");
        const auto capacity = sizeof(detail->InfFileName) / sizeof(wchar_t); size_t length = 0;
        while (length < capacity && detail->InfFileName[length]) ++length;
        if (!length || length == capacity) Fail("DRIVER_DETAIL_REFUSED");
        if (!_wcsicmp(PublishedName(detail->InfFileName).c_str(), expected.c_str())) { selected = candidate; ++matches; }
        if (index == 31) Fail("DRIVER_SELECTION_LIMIT");
    }
    if (matches != 1) Fail("EXACT_DRIVER_SELECTION_REFUSED"); return selected;
}
std::wstring PresentInterface(const std::wstring& instance) {
    auto interfaceId = reviewops::display::InterfaceId;
    for (size_t attempt = 0; attempt < 3; ++attempt) {
        ULONG chars = 0;
        CONFIGRET result = CM_Get_Device_Interface_List_SizeW(&chars, &interfaceId, const_cast<PWSTR>(instance.c_str()), CM_GET_DEVICE_INTERFACE_LIST_PRESENT);
        if (result != CR_SUCCESS) Fail("DEVICE_INTERFACE_UNCONFIRMED", static_cast<LONG>(result));
        if (!chars || chars > 32768) Fail("DEVICE_INTERFACE_LIST_REFUSED");
        std::vector<wchar_t> list(chars, L'\0');
        result = CM_Get_Device_Interface_ListW(&interfaceId, const_cast<PWSTR>(instance.c_str()), list.data(), chars, CM_GET_DEVICE_INTERFACE_LIST_PRESENT);
        if (result == CR_BUFFER_SMALL) continue;
        if (result != CR_SUCCESS) Fail("DEVICE_INTERFACE_UNCONFIRMED", static_cast<LONG>(result));
        std::wstring selected; size_t count = 0, offset = 0;
        while (offset < list.size() && list[offset]) {
            size_t end = offset; while (end < list.size() && list[end]) ++end;
            if (end == list.size() || end - offset > 4096) Fail("DEVICE_INTERFACE_LIST_REFUSED");
            selected.assign(list.data() + offset, end - offset); ++count; offset = end + 1;
        }
        if (offset >= list.size() || count > 1) Fail("DEVICE_INTERFACE_LIST_REFUSED");
        return selected;
    }
    Fail("DEVICE_INTERFACE_LIST_CHANGED");
}
} // namespace internal

struct OwnedSoftwareDevice::Impl {
    std::shared_ptr<const install::InstalledPackage> package;
    internal::EnumerationState enumeration;
    std::mutex operation;
    std::atomic<bool> retired{false};
    std::atomic<bool> installAttempted{false}, rebootRequired{false};
    std::wstring controlInterface;
    [[noreturn]] void RejectIdentity(const char* reason) {
        // Called under operation, never callbackLock. Do not recurse into the
        // public Close method while holding the operation mutex.
        retired.store(true); controlInterface.clear(); enumeration.Close(); internal::Fail(reason);
    }
    void Current() const {
        if (retired.load() || !enumeration.enumerated || !enumeration.original) internal::Fail("OWNED_DEVICE_RETIRED");
        if (!package || !package->Revalidate()) internal::Fail("INSTALLED_PACKAGE_CHANGED");
    }
    DeviceObservation Observe() {
        controlInterface.clear(); Current();
        internal::DeviceInfo info(enumeration.instance); internal::CheckInstance(info, enumeration.instance);
        const auto inf = internal::StringProperty(info, DEVPKEY_Device_DriverInfPath, true);
        DeviceObservation observation; observation.enumerated = true; observation.installAttempted = installAttempted.load(); observation.rebootRequired = rebootRequired.load();
        if (inf.empty()) { observation.reason = "OWNED_DEVICE_DRIVER_PENDING"; return observation; }
        if (!internal::OemName(inf) || _wcsicmp(inf.c_str(), package->PublishedInfName().c_str())) RejectIdentity("OWNED_DEVICE_DRIVER_MISMATCH");
        if (!internal::Same(internal::DeviceClass(info), internal::DisplayClass)) RejectIdentity("OWNED_DEVICE_CLASS_MISMATCH");
        observation.driverConfirmed = true;
        const auto present = internal::PresentInterface(enumeration.instance);
        internal::CheckInstance(info, enumeration.instance);
        if (_wcsicmp(internal::StringProperty(info, DEVPKEY_Device_DriverInfPath).c_str(), inf.c_str())) RejectIdentity("OWNED_DEVICE_DRIVER_CHANGED");
        Current(); controlInterface = present; observation.interfacePresent = !present.empty();
        observation.reason = observation.interfacePresent ? "OWNED_DEVICE_INTERFACE_PRESENT_PROTOCOL_UNCHECKED" : "OWNED_DEVICE_INTERFACE_PENDING";
        return observation;
    }
};
OwnedSoftwareDevice::OwnedSoftwareDevice(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
OwnedSoftwareDevice::~OwnedSoftwareDevice() { Close(); }
OwnedSoftwareDevice::OwnedSoftwareDevice(OwnedSoftwareDevice&&) noexcept = default;
TrustedProjectBinding OwnedSoftwareDevice::Binding() const noexcept { return impl_ ? impl_->enumeration.binding : TrustedProjectBinding{}; }
std::wstring OwnedSoftwareDevice::InstanceId() const {
    if (!impl_) return {}; std::lock_guard<std::mutex> lock(impl_->operation); return impl_->enumeration.instance;
}
DeviceObservation OwnedSoftwareDevice::CheckInstalledDevice() noexcept {
    DeviceObservation observation;
    try { if (!impl_) internal::Fail("OWNED_DEVICE_RETIRED"); std::lock_guard<std::mutex> lock(impl_->operation); return impl_->Observe(); }
    catch (const internal::Failure& e) { observation.reason = e.reason; observation.nativeCode = e.code; }
    catch (...) { observation.reason = "DEVICE_OBSERVATION_FAILED"; observation.nativeCode = ERROR_UNHANDLED_EXCEPTION; }
    if (impl_) { observation.enumerated = impl_->enumeration.enumerated.load() && !impl_->retired.load(); observation.installAttempted = impl_->installAttempted.load(); observation.rebootRequired = impl_->rebootRequired.load(); }
    return observation;
}
DeviceObservation OwnedSoftwareDevice::InstallAndVerifyDriver() noexcept {
    DeviceObservation observation;
    try {
        if (!impl_) internal::Fail("OWNED_DEVICE_RETIRED"); std::lock_guard<std::mutex> lock(impl_->operation);
        internal::RequireElevated(); impl_->Current();
        internal::DeviceInfo info(impl_->enumeration.instance); internal::CheckInstance(info, impl_->enumeration.instance);
        const auto inf = internal::StringProperty(info, DEVPKEY_Device_DriverInfPath, true);
        if (!inf.empty()) {
            if (_wcsicmp(inf.c_str(), impl_->package->PublishedInfName().c_str())) impl_->RejectIdentity("OWNED_DEVICE_DRIVER_MISMATCH");
            return impl_->Observe();
        }
        if (impl_->installAttempted.load()) internal::Fail("OWNED_DRIVER_INSTALL_REPLAY_REFUSED");
        auto selected = internal::ExactDriver(info, *impl_->package);
        impl_->Current(); internal::CheckInstance(info, impl_->enumeration.instance);
        // PnP may have bound a driver while the explicit driver list was built.
        const auto current = internal::StringProperty(info, DEVPKEY_Device_DriverInfPath, true);
        if (!current.empty()) {
            if (_wcsicmp(current.c_str(), impl_->package->PublishedInfName().c_str())) impl_->RejectIdentity("OWNED_DEVICE_DRIVER_MISMATCH");
            return impl_->Observe();
        }
        BOOL reboot = FALSE; impl_->installAttempted = true;
        const BOOL installed = DiInstallDevice(nullptr, info.set, &info.device, &selected, 0, &reboot);
        const DWORD error = installed ? ERROR_SUCCESS : GetLastError(); impl_->rebootRequired = reboot != FALSE;
        if (!installed) internal::Fail("OWNED_DRIVER_INSTALL_UNCONFIRMED_NO_REPLAY", static_cast<LONG>(error));
        impl_->Current(); return impl_->Observe();
    } catch (const internal::Failure& e) { observation.reason = e.reason; observation.nativeCode = e.code; }
    catch (...) { observation.reason = "OWNED_DRIVER_INSTALL_UNCONFIRMED_NO_REPLAY"; observation.nativeCode = ERROR_UNHANDLED_EXCEPTION; }
    if (impl_) { observation.enumerated = impl_->enumeration.enumerated.load() && !impl_->retired.load(); observation.installAttempted = impl_->installAttempted.load(); observation.rebootRequired = impl_->rebootRequired.load(); }
    return observation;
}
std::wstring OwnedSoftwareDevice::InternalControlInterfacePath() const {
    if (!impl_) return {}; std::lock_guard<std::mutex> lock(impl_->operation);
    const auto observation = impl_->Observe();
    return observation.interfacePresent ? impl_->controlInterface : std::wstring{};
}
CloseObservation OwnedSoftwareDevice::Close() noexcept {
    if (!impl_) return {}; impl_->retired.store(true);
    try {
        std::lock_guard<std::mutex> lock(impl_->operation); impl_->controlInterface.clear(); return impl_->enumeration.Close();
    } catch (...) { return {}; }
}
DeviceCreation CreateOwnedSoftwareDevice(std::shared_ptr<const install::InstalledPackage> package, const TrustedProjectBinding& binding) {
    DeviceCreation result;
    try {
        internal::RequireElevated(); internal::CheckBinding(binding);
        if (!package || !package->Revalidate()) internal::Fail("INSTALLED_PACKAGE_REFUSED");
        auto impl = std::make_unique<OwnedSoftwareDevice::Impl>(); impl->package = std::move(package);
        result.owner = std::unique_ptr<OwnedSoftwareDevice>(new OwnedSoftwareDevice(std::move(impl)));
        internal::StartEnumeration(result.owner->impl_->enumeration, internal::NativeOps, binding, internal::CreationWaitMs);
        result.owner->impl_->Current(); result.observation.enumerated = true; result.observation.reason = "DEVICE_ENUMERATED_DRIVER_UNCHECKED";
    } catch (const internal::Failure& e) { result.observation.reason = e.reason; result.observation.nativeCode = e.code; if (result.owner) result.owner->Close(); }
    catch (...) { result.observation.reason = "DEVICE_CREATION_UNCONFIRMED_NO_REPLAY"; result.observation.nativeCode = ERROR_UNHANDLED_EXCEPTION; if (result.owner) result.owner->Close(); }
    return result;
}
} // namespace reviewops::display::softwaredevice
