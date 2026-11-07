#include "PackageInstall.h"

#include <aclapi.h>
#include <bcrypt.h>
#include <setupapi.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <cwctype>
#include <mutex>
#include <utility>
#include <vector>

namespace reviewops::display::install {
namespace internal {
constexpr std::array<const wchar_t*, 3> Names = {L"ReviewOpsVirtualDisplay.inf", L"ReviewOpsVirtualDisplay.dll", L"reviewopsvirtualdisplay.cat"};
constexpr std::array<uint64_t, 3> Limits = {65536, 16 * 1024 * 1024, 4 * 1024 * 1024};
struct Failure { const char* reason; LONG code; };
[[noreturn]] void Fail(const char* reason, LONG code = ERROR_SUCCESS) { throw Failure{reason, code}; }
void Check(BOOL value, const char* reason) { if (!value) Fail(reason, static_cast<LONG>(GetLastError())); }
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept { if (this != &other) { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); value = std::exchange(other.value, INVALID_HANDLE_VALUE); } return *this; }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct LocalMemory { PVOID value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
struct Identity { ULONGLONG volume = 0; FILE_ID_128 file{}; };
uint64_t Size(const BY_HANDLE_FILE_INFORMATION& i) { return (uint64_t(i.nFileSizeHigh) << 32) | i.nFileSizeLow; }
BY_HANDLE_FILE_INFORMATION Information(HANDLE h, bool directory) {
    BY_HANDLE_FILE_INFORMATION i{}; Check(GetFileInformationByHandle(h, &i), "IMPORT_IDENTITY_REFUSED");
    if (GetFileType(h) != FILE_TYPE_DISK || (i.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || bool(i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory)
        Fail("IMPORT_UNSAFE_OBJECT");
    // Multiple links are allowed only for this private OS-managed package view.
    // Distribution/staging admission keeps its independent strict link policy.
    return i;
}
Identity Identify(HANDLE h, bool directory) {
    Information(h, directory); FILE_ID_INFO id{};
    Check(GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id)), "IMPORT_IDENTITY_REFUSED"); return {id.VolumeSerialNumber, id.FileId};
}
bool Same(const Identity& a, const Identity& b) { return a.volume == b.volume && !std::memcmp(a.file.Identifier, b.file.Identifier, sizeof(a.file.Identifier)); }
std::wstring FinalPath(HANDLE h, DWORD volume = VOLUME_NAME_GUID) {
    std::array<wchar_t, 512> output{};
    const DWORD count = GetFinalPathNameByHandleW(h, output.data(), static_cast<DWORD>(output.size()), FILE_NAME_NORMALIZED | volume);
    if (!count || count >= output.size()) Fail("IMPORT_PATH_REFUSED", static_cast<LONG>(GetLastError())); return std::wstring(output.data(), count);
}
std::wstring DosPath(HANDLE h) {
    auto path = FinalPath(h, VOLUME_NAME_DOS);
    if (path.rfind(L"\\\\?\\", 0) != 0) Fail("IMPORT_PATH_REFUSED"); path.erase(0, 4);
    if (path.size() < 4 || path[1] != L':' || path[2] != L'\\' || path.size() >= MAX_PATH) Fail("IMPORT_PATH_REFUSED"); return path;
}
void RequireElevated() {
    HANDLE thread = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) { CloseHandle(thread); Fail("IMPORT_IMPERSONATION_REFUSED"); }
    const DWORD error = GetLastError(); if (error != ERROR_NO_TOKEN) Fail("IMPORT_TOKEN_REFUSED", static_cast<LONG>(error));
    HANDLE raw = nullptr; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "IMPORT_TOKEN_REFUSED"); Handle token(raw);
    TOKEN_ELEVATION elevation{}; DWORD count = 0; Check(GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &count), "IMPORT_TOKEN_REFUSED");
    std::array<BYTE, SECURITY_MAX_SID_SIZE> sid{}; DWORD length = static_cast<DWORD>(sid.size());
    Check(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, sid.data(), &length), "IMPORT_TOKEN_REFUSED");
    BOOL member = FALSE; Check(CheckTokenMembership(nullptr, sid.data(), &member), "IMPORT_TOKEN_REFUSED");
    if (!elevation.TokenIsElevated || !member) Fail("IMPORT_ELEVATION_REQUIRED");
}
bool TrustedSid(PSID sid) {
    if (IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) return true;
    std::array<BYTE, SECURITY_MAX_SID_SIZE> service{}; DWORD bytes = static_cast<DWORD>(service.size());
    std::array<wchar_t, 64> domain{}; DWORD chars = static_cast<DWORD>(domain.size()); SID_NAME_USE use{};
    return LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", service.data(), &bytes, domain.data(), &chars, &use) &&
        !_wcsicmp(domain.data(), L"NT SERVICE") && EqualSid(sid, service.data());
}
void Protected(HANDLE h) {
    PSID owner = nullptr; PACL acl = nullptr; LocalMemory descriptor;
    const DWORD code = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    if (code != ERROR_SUCCESS) Fail("IMPORT_SECURITY_REFUSED", static_cast<LONG>(code));
    if (!owner || !TrustedSid(owner) || !acl || !IsValidAcl(acl)) Fail("IMPORT_SECURITY_REFUSED");
    constexpr DWORD unsafe = GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE | FILE_DELETE_CHILD | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
    for (DWORD index = 0; index < acl->AceCount; ++index) {
        PVOID raw = nullptr; Check(GetAce(acl, index, &raw), "IMPORT_SECURITY_REFUSED"); const auto header = static_cast<ACE_HEADER*>(raw);
        if ((header->AceFlags & INHERIT_ONLY_ACE) || header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) Fail("IMPORT_SECURITY_REFUSED");
        const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if ((ace->Mask & unsafe) && !TrustedSid(const_cast<DWORD*>(&ace->SidStart))) Fail("IMPORT_SECURITY_REFUSED");
    }
}
std::string Digest(HANDLE file, uint64_t limit) {
    const auto info = Information(file, false); if (!Size(info) || Size(info) > limit) Fail("IMPORT_FILE_REFUSED");
    struct Hash { BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
        ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); } } state;
    auto check = [](NTSTATUS code) { if (code < 0) Fail("IMPORT_HASH_REFUSED", code); };
    check(BCryptOpenAlgorithmProvider(&state.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0)); check(BCryptCreateHash(state.algorithm, &state.hash, nullptr, 0, nullptr, 0, 0));
    LARGE_INTEGER zero{}; Check(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "IMPORT_HASH_REFUSED");
    std::array<BYTE, 65536> buffer{}; uint64_t total = 0;
    for (;;) { DWORD count = 0; Check(ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr), "IMPORT_HASH_REFUSED");
        if (!count) break; total += count; if (total > limit) Fail("IMPORT_FILE_REFUSED"); check(BCryptHashData(state.hash, buffer.data(), count, 0)); }
    if (total != Size(info)) Fail("IMPORT_FILE_CHANGED");
    std::array<BYTE, 32> hash{}; check(BCryptFinishHash(state.hash, hash.data(), static_cast<ULONG>(hash.size()), 0));
    Check(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "IMPORT_HASH_REFUSED");
    constexpr char hex[] = "0123456789abcdef"; std::string result(64, '0');
    for (size_t i = 0; i < hash.size(); ++i) { result[i * 2] = hex[hash[i] >> 4]; result[i * 2 + 1] = hex[hash[i] & 15]; } return result;
}
struct Opened { Handle handle; Identity id; std::wstring path; bool directory = false; };
Opened Open(const std::wstring& path, bool directory) {
    Opened result; result.path = path; result.directory = directory;
    result.handle = Handle(CreateFileW(path.c_str(), (directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ) | READ_CONTROL,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
    Check(result.handle.value != INVALID_HANDLE_VALUE, "IMPORT_OPEN_REFUSED"); result.id = Identify(result.handle.value, directory); Protected(result.handle.value);
    if (_wcsicmp(FinalPath(result.handle.value).c_str(), path.c_str())) Fail("IMPORT_PATH_REFUSED"); return result;
}
void Recheck(const Opened& value) {
    if (!Same(Identify(value.handle.value, value.directory), value.id) || _wcsicmp(FinalPath(value.handle.value).c_str(), value.path.c_str())) Fail("IMPORT_FILE_CHANGED"); Protected(value.handle.value);
}
bool Component(const std::wstring& part) {
    return !part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ' && part.find_first_of(L"\\/:\"<>|?*~") == std::wstring::npos &&
        std::all_of(part.begin(), part.end(), [](wchar_t c) { return c >= 32 && c != 127; });
}
struct SystemRoots {
    std::vector<Opened> directories;
    std::wstring infRootDOS, repositoryDOS, boundInf, boundRepository;
};
SystemRoots OpenSystemRoots() {
    RequireElevated(); SystemRoots result;
    std::array<wchar_t, MAX_PATH> windows{}; const UINT count = GetSystemWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    if (!count || count >= windows.size()) Fail("IMPORT_OS_ROOT_REFUSED", static_cast<LONG>(GetLastError()));
    const std::wstring win(windows.data(), count);
    result.infRootDOS = win + L"\\INF"; result.repositoryDOS = win + L"\\System32\\DriverStore\\FileRepository";
    if (win.size() < 4 || win[1] != L':' || win[2] != L'\\' || GetDriveTypeW(win.substr(0, 3).c_str()) != DRIVE_FIXED) Fail("IMPORT_OS_ROOT_REFUSED");
    Handle root(CreateFileW(win.substr(0, 3).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Check(root.value != INVALID_HANDLE_VALUE, "IMPORT_OS_ROOT_REFUSED"); const auto volume = FinalPath(root.value);
    if (volume.rfind(L"\\\\?\\Volume{", 0) || volume.size() != 49 || volume.substr(47) != L"}\\") Fail("IMPORT_OS_ROOT_REFUSED");
    auto bind = [&](const std::wstring& dos) {
        const auto bound = volume + dos.substr(3); result.directories.push_back(Open(volume, true));
        for (size_t end = volume.size(); end <= bound.size(); ++end) {
            if (end != bound.size() && bound[end] != L'\\') continue;
            const auto separator = bound.rfind(L'\\', end - 1);
            if (!Component(bound.substr(separator + 1, end - separator - 1))) Fail("IMPORT_OS_ROOT_REFUSED");
            result.directories.push_back(Open(bound.substr(0, end), true));
        }
        return bound;
    };
    result.boundInf = bind(result.infRootDOS); result.boundRepository = bind(result.repositoryDOS);
    return result;
}
bool OemName(const std::wstring& name) {
    if (name.size() < 8 || name.size() > 32 || _wcsnicmp(name.c_str(), L"oem", 3) || _wcsicmp(name.c_str() + name.size() - 4, L".inf")) return false;
    for (size_t i = 3; i < name.size() - 4; ++i) if (name[i] < L'0' || name[i] > L'9') return false; return true;
}
ImportDisposition ClassifyCopyOutcome(BOOL success, DWORD error) {
    return success ? ImportDisposition::Imported : error == ERROR_FILE_EXISTS ? ImportDisposition::AlreadyPresent : ImportDisposition::Uncertain;
}
struct CopyOutcome { ImportDisposition disposition; std::wstring publishedName, publishedPath; };
CopyOutcome ParseCopyOutput(BOOL success, DWORD error, const std::array<wchar_t, MAX_PATH>& output, DWORD required, PWSTR component, const std::wstring& expectedSystemInfDirectory) {
    const auto disposition = ClassifyCopyOutcome(success, error);
    if (disposition == ImportDisposition::Uncertain) Fail("IMPORT_COPY_UNCERTAIN", static_cast<LONG>(error));
    size_t length = 0; while (length < output.size() && output[length]) ++length;
    if (!length || length == output.size() || required != length + 1 || !component) Fail("IMPORT_OUTPUT_REFUSED");
    const auto start = reinterpret_cast<uintptr_t>(output.data()), pointer = reinterpret_cast<uintptr_t>(component);
    if (pointer < start || pointer >= start + length * sizeof(wchar_t) || (pointer - start) % sizeof(wchar_t)) Fail("IMPORT_OUTPUT_REFUSED");
    const size_t offset = (pointer - start) / sizeof(wchar_t); const std::wstring path(output.data(), length), name(output.data() + offset, length - offset);
    if (!OemName(name) || _wcsicmp(path.c_str(), (expectedSystemInfDirectory + L"\\" + name).c_str()) || offset != expectedSystemInfDirectory.size() + 1) Fail("IMPORT_OUTPUT_REFUSED");
    return {disposition, name, path};
}
struct Fingerprint { Identity id; uint64_t size; std::string hash; };
std::unique_ptr<admission::VerifiedPackage> Refresh(staging::StagedPackage& stage, const std::array<Fingerprint, 3>& expected) {
    if (!stage.Revalidate() || !stage.Verified()) Fail("IMPORT_SOURCE_REFUSED");
    const auto original = stage.Verified(); auto fresh = admission::InspectPackage(DosPath(original->DirectoryHandle()));
    if (!fresh.package) Fail(fresh.reason, fresh.nativeCode);
    if (!Same(Identify(original->DirectoryHandle(), true), Identify(fresh.package->DirectoryHandle(), true))) Fail("IMPORT_SOURCE_CHANGED");
    for (size_t i = 0; i < Names.size(); ++i) {
        if (!Same(Identify(fresh.package->FileHandle(static_cast<admission::PackageFile>(i)), false), expected[i].id) ||
            fresh.files[i].size != expected[i].size || fresh.files[i].sha256 != expected[i].hash) Fail("IMPORT_SOURCE_CHANGED");
    }
    return std::move(fresh.package);
}
} // namespace internal

struct InstalledPackage::Impl {
    mutable std::mutex gate;
    std::unique_ptr<staging::StagedPackage> source;
    std::array<internal::Fingerprint, 3> expected;
    std::vector<internal::Opened> directories;
    std::array<internal::Opened, 3> store;
    internal::Opened published;
    std::wstring publishedName, storeInfPath;
    void Verify() const {
        internal::RequireElevated(); auto fresh = internal::Refresh(*source, expected);
        for (const auto& directory : directories) internal::Recheck(directory);
        for (size_t i = 0; i < store.size(); ++i) {
            internal::Recheck(store[i]);
            if (internal::Size(internal::Information(store[i].handle.value, false)) != expected[i].size || internal::Digest(store[i].handle.value, internal::Limits[i]) != expected[i].hash) internal::Fail("IMPORT_STORE_MISMATCH");
        }
        internal::Recheck(published);
        if (internal::Size(internal::Information(published.handle.value, false)) != expected[0].size || internal::Digest(published.handle.value, internal::Limits[0]) != expected[0].hash) internal::Fail("IMPORT_PUBLISHED_MISMATCH");
        if (!source->Revalidate()) internal::Fail("IMPORT_SOURCE_CHANGED");
    }
};
InstalledPackage::InstalledPackage(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
InstalledPackage::~InstalledPackage() = default; // Never uninstall an OS package.
InstalledPackage::InstalledPackage(InstalledPackage&&) noexcept = default;
bool InstalledPackage::Revalidate() const noexcept {
    if (!impl_) return false; try { std::lock_guard<std::mutex> lock(impl_->gate); impl_->Verify(); return true; } catch (...) { return false; }
}
std::wstring InstalledPackage::PublishedInfName() const { if (!impl_) return {}; std::lock_guard<std::mutex> lock(impl_->gate); return impl_->publishedName; }
std::wstring InstalledPackage::InternalDriverStoreInfPath() const { if (!impl_) return {}; std::lock_guard<std::mutex> lock(impl_->gate); return impl_->storeInfPath; }

ImportResult ImportVerifiedPackage(staging::StagedPackage&& source) {
    ImportResult result; std::unique_ptr<InstalledPackage::Impl> state;
    try {
        internal::RequireElevated(); if (!source.Revalidate() || !source.Verified()) internal::Fail("IMPORT_SOURCE_REFUSED");
        state = std::make_unique<InstalledPackage::Impl>(); state->source = std::make_unique<staging::StagedPackage>(std::move(source));
        for (size_t i = 0; i < internal::Names.size(); ++i) {
            const HANDLE h = state->source->Verified()->FileHandle(static_cast<admission::PackageFile>(i));
            state->expected[i] = {internal::Identify(h, false), internal::Size(internal::Information(h, false)), internal::Digest(h, internal::Limits[i])};
        }
        auto refreshed = internal::Refresh(*state->source, state->expected);
        // A DOS alias must not redirect the import's side effect after validation.
        // Unsupported canonical-volume paths fail without a fallback or retry.
        const auto sourceInf = internal::FinalPath(refreshed->FileHandle(admission::PackageFile::Inf));
        if (sourceInf.size() >= MAX_PATH) internal::Fail("IMPORT_PATH_REFUSED");
        auto roots = internal::OpenSystemRoots(); state->directories = std::move(roots.directories);
        // Preflight is complete before this one irreversible import attempt.
        internal::RequireElevated(); if (!state->source->Revalidate()) internal::Fail("IMPORT_SOURCE_CHANGED");
        std::array<wchar_t, MAX_PATH> destination{}; DWORD required = 0; PWSTR component = nullptr;
        result.importAttempted = true;
        // https://learn.microsoft.com/windows/win32/api/setupapi/nf-setupapi-setupcopyoeminfw
        const BOOL copied = SetupCopyOEMInfW(sourceInf.c_str(), nullptr, SPOST_PATH, SP_COPY_NOOVERWRITE, destination.data(), static_cast<DWORD>(destination.size()), &required, &component);
        result.apiSucceeded = copied != FALSE; result.setupError = copied ? ERROR_SUCCESS : GetLastError();
        result.disposition = internal::ClassifyCopyOutcome(copied, result.setupError);
        const auto output = internal::ParseCopyOutput(copied, result.setupError, destination, required, component, roots.infRootDOS);
        result.publishedInfName = output.publishedName; state->publishedName = output.publishedName;
        if (!state->source->Revalidate()) internal::Fail("IMPORT_SOURCE_CHANGED");
        state->published = internal::Open(roots.boundInf + L"\\" + output.publishedName, false);
        std::array<wchar_t, MAX_PATH> location{}; DWORD locationRequired = 0;
        // The actual OEM basename resolves in the system INF directory without
        // accepting a caller root or reusing a mutable DOS alias for this lookup.
        internal::Check(SetupGetInfDriverStoreLocationW(output.publishedName.c_str(), nullptr, nullptr, location.data(), static_cast<DWORD>(location.size()), &locationRequired), "IMPORT_STORE_LOOKUP_REFUSED");
        size_t length = 0; while (length < location.size() && location[length]) ++length;
        if (!length || length == location.size() || locationRequired > location.size()) internal::Fail("IMPORT_STORE_PATH_REFUSED");
        const std::wstring mapped(location.data(), length), prefix = roots.repositoryDOS + L"\\";
        if (mapped.size() <= prefix.size() || _wcsnicmp(mapped.c_str(), prefix.c_str(), prefix.size())) internal::Fail("IMPORT_STORE_PATH_REFUSED");
        const auto tail = mapped.substr(prefix.size()); const auto slash = tail.find(L'\\');
        if (slash == std::wstring::npos || !internal::Component(tail.substr(0, slash)) || _wcsicmp(tail.substr(slash + 1).c_str(), internal::Names[0])) internal::Fail("IMPORT_STORE_PATH_REFUSED");
        const auto storeDirectory = roots.boundRepository + L"\\" + tail.substr(0, slash); state->directories.push_back(internal::Open(storeDirectory, true));
        for (size_t i = 0; i < internal::Names.size(); ++i) state->store[i] = internal::Open(storeDirectory + L"\\" + internal::Names[i], false);
        state->storeInfPath = storeDirectory + L"\\" + internal::Names[0]; state->Verify();
        result.package = std::unique_ptr<InstalledPackage>(new InstalledPackage(std::move(state))); result.ready = true;
        result.reason = "IMPORTED_AND_VERIFIED";
    } catch (const internal::Failure& e) { result.reason = e.reason; result.nativeCode = e.code; }
    catch (...) { result.reason = "IMPORT_FAILED"; result.nativeCode = ERROR_UNHANDLED_EXCEPTION; }
    if (!result.ready && state) {
        result.staging = std::move(state->source);
        if (result.importAttempted && result.disposition != ImportDisposition::Uncertain) result.disposition = ImportDisposition::PublishedUnqualified;
    }
    return result;
}
} // namespace reviewops::display::install
