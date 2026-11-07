#include "PackageStaging.h"

#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shlobj.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <utility>
#include <vector>

namespace reviewops::display::staging {
// Implementation helpers have no declaration in the production public header.
// A dedicated test translation unit can include this file to exercise copying
// and scoped cleanup without constructing a VerifiedPackage or bypassing trust.
namespace internal {
constexpr std::array<const wchar_t*, 3> Names = {L"ReviewOpsVirtualDisplay.inf", L"ReviewOpsVirtualDisplay.dll", L"reviewopsvirtualdisplay.cat"};
constexpr std::array<uint64_t, 3> Limits = {65536, 16 * 1024 * 1024, 4 * 1024 * 1024};
struct Failure { const char* reason; LONG code; };
[[noreturn]] void Fail(const char* reason, LONG code = ERROR_SUCCESS) { throw Failure{reason, code}; }
void Check(BOOL value, const char* reason) { if (!value) Fail(reason, static_cast<LONG>(GetLastError())); }
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    ~Handle() { Reset(); }
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept { if (this != &other) { Reset(); value = std::exchange(other.value, INVALID_HANDLE_VALUE); } return *this; }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    void Reset() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct LocalMemory { PVOID value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
struct Identity {
    ULONGLONG volume = 0;
    FILE_ID_128 file{};
    bool valid = false;
};
uint64_t Size(const BY_HANDLE_FILE_INFORMATION& i) { return (uint64_t(i.nFileSizeHigh) << 32) | i.nFileSizeLow; }
BY_HANDLE_FILE_INFORMATION Information(HANDLE h, bool directory) {
    BY_HANDLE_FILE_INFORMATION i{}; Check(GetFileInformationByHandle(h, &i), "STAGING_IDENTITY_FAILED");
    if (GetFileType(h) != FILE_TYPE_DISK || (i.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory || (!directory && i.nNumberOfLinks != 1)) Fail("STAGING_UNSAFE_OBJECT");
    return i;
}
Identity Identify(HANDLE h, bool directory) {
    Information(h, directory); FILE_ID_INFO identity{};
    Check(GetFileInformationByHandleEx(h, FileIdInfo, &identity, sizeof(identity)), "STAGING_IDENTITY_FAILED");
    return {identity.VolumeSerialNumber, identity.FileId, true};
}
bool Matches(HANDLE h, const Identity& original, bool directory) {
    const auto i = Identify(h, directory);
    return original.valid && i.volume == original.volume && !std::memcmp(i.file.Identifier, original.file.Identifier, sizeof(i.file.Identifier));
}
std::wstring FinalPath(HANDLE h, DWORD volume = VOLUME_NAME_GUID) {
    std::array<wchar_t, 512> buffer{};
    const DWORD count = GetFinalPathNameByHandleW(h, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | volume);
    if (!count || count >= buffer.size()) Fail("STAGING_PATH_REFUSED", static_cast<LONG>(GetLastError()));
    return std::wstring(buffer.data(), count);
}
void RequireElevated() {
    HANDLE thread = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) { CloseHandle(thread); Fail("STAGING_IMPERSONATION_REFUSED"); }
    const DWORD threadError = GetLastError();
    if (threadError != ERROR_NO_TOKEN) Fail("STAGING_TOKEN_REFUSED", static_cast<LONG>(threadError));
    HANDLE raw = nullptr; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "STAGING_TOKEN_REFUSED"); Handle token(raw);
    TOKEN_ELEVATION elevation{}; DWORD count = 0;
    Check(GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &count), "STAGING_TOKEN_REFUSED");
    std::array<BYTE, SECURITY_MAX_SID_SIZE> sid{}; DWORD bytes = static_cast<DWORD>(sid.size());
    Check(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, sid.data(), &bytes), "STAGING_TOKEN_REFUSED");
    BOOL member = FALSE; Check(CheckTokenMembership(nullptr, sid.data(), &member), "STAGING_TOKEN_REFUSED");
    if (!elevation.TokenIsElevated || !member) Fail("STAGING_ELEVATION_REQUIRED");
}
bool SystemOrAdmin(PSID sid) { return IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid); }
bool TrustedParentSid(PSID sid) {
    if (SystemOrAdmin(sid)) return true;
    // Resolve only the fixed local Windows servicing identity; never caller names.
    std::array<BYTE, SECURITY_MAX_SID_SIZE> service{}; DWORD bytes = static_cast<DWORD>(service.size());
    std::array<wchar_t, 64> domain{}; DWORD chars = static_cast<DWORD>(domain.size()); SID_NAME_USE use{};
    return LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", service.data(), &bytes, domain.data(), &chars, &use) &&
        !_wcsicmp(domain.data(), L"NT SERVICE") && EqualSid(sid, service.data());
}
void Security(HANDLE h, bool own) {
    PSID owner = nullptr; PACL acl = nullptr; LocalMemory descriptor;
    const DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    if (error != ERROR_SUCCESS) Fail("STAGING_SECURITY_REFUSED", static_cast<LONG>(error));
    if (!owner || !acl || !IsValidAcl(acl) || (own ? !IsWellKnownSid(owner, WinBuiltinAdministratorsSid) : !TrustedParentSid(owner))) Fail("STAGING_SECURITY_REFUSED");
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    Check(GetSecurityDescriptorControl(descriptor.value, &control, &revision), "STAGING_SECURITY_REFUSED");
    if (own && (!(control & SE_DACL_PROTECTED) || acl->AceCount != 2)) Fail("STAGING_SECURITY_REFUSED");
    bool system = false, admins = false;
    constexpr DWORD unsafe = GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE | FILE_DELETE_CHILD | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
    for (DWORD index = 0; index < acl->AceCount; ++index) {
        PVOID raw = nullptr; Check(GetAce(acl, index, &raw), "STAGING_SECURITY_REFUSED");
        const auto header = static_cast<ACE_HEADER*>(raw);
        if (!own && (header->AceFlags & INHERIT_ONLY_ACE)) continue;
        if (!own && header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) Fail("STAGING_SECURITY_REFUSED");
        const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw); PSID sid = const_cast<DWORD*>(&ace->SidStart);
        if (own) {
            if (!SystemOrAdmin(sid) || ace->Mask != FILE_ALL_ACCESS || (header->AceFlags & (INHERITED_ACE | INHERIT_ONLY_ACE))) Fail("STAGING_SECURITY_REFUSED");
            system = system || IsWellKnownSid(sid, WinLocalSystemSid); admins = admins || IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
        } else if ((ace->Mask & unsafe) && !TrustedParentSid(sid)) Fail("STAGING_SECURITY_REFUSED");
    }
    if (own && (!system || !admins)) Fail("STAGING_SECURITY_REFUSED");
}
struct Descriptor {
    LocalMemory memory;
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
    explicit Descriptor(bool directory) {
        // Protected at creation, not widened then repaired. BA owner prevents a
        // filtered administrator's user SID from retaining owner WRITE_DAC rights.
        const auto sddl = directory ? L"O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" : L"O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)";
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1,
            reinterpret_cast<PSECURITY_DESCRIPTOR*>(&memory.value), nullptr), "STAGING_SECURITY_REFUSED");
        attributes.lpSecurityDescriptor = memory.value;
    }
};
Handle OpenDirectory(const std::wstring& path, DWORD extra = 0) {
    Handle h(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | extra, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Check(h.value != INVALID_HANDLE_VALUE, "STAGING_OPEN_FAILED"); Information(h.value, true); return h;
}
std::string Digest(HANDLE h, uint64_t limit) {
    const auto before = Information(h, false); if (!Size(before) || Size(before) > limit) Fail("STAGING_SOURCE_REFUSED");
    struct Hash { BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
        ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); } } state;
    auto check = [](NTSTATUS code) { if (code < 0) Fail("STAGING_HASH_FAILED", code); };
    check(BCryptOpenAlgorithmProvider(&state.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
    check(BCryptCreateHash(state.algorithm, &state.hash, nullptr, 0, nullptr, 0, 0));
    LARGE_INTEGER zero{}; Check(SetFilePointerEx(h, zero, nullptr, FILE_BEGIN), "STAGING_COPY_FAILED");
    std::array<BYTE, 65536> buffer{}; uint64_t total = 0;
    for (;;) { DWORD count = 0; Check(ReadFile(h, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr), "STAGING_COPY_FAILED");
        if (!count) break; total += count; if (total > limit) Fail("STAGING_SOURCE_REFUSED"); check(BCryptHashData(state.hash, buffer.data(), count, 0)); }
    if (total != Size(before)) Fail("STAGING_SOURCE_CHANGED");
    std::array<BYTE, 32> hash{}; check(BCryptFinishHash(state.hash, hash.data(), static_cast<ULONG>(hash.size()), 0));
    Check(SetFilePointerEx(h, zero, nullptr, FILE_BEGIN), "STAGING_COPY_FAILED");
    constexpr char hex[] = "0123456789abcdef"; std::string result(64, '0');
    for (size_t i = 0; i < hash.size(); ++i) { result[i * 2] = hex[hash[i] >> 4]; result[i * 2 + 1] = hex[hash[i] & 15]; }
    return result;
}
struct CopyRecord { bool created = false; Identity id; uint64_t size = 0; std::string hash; };
struct OwnedStage {
    std::vector<Handle> parents;
    std::vector<Identity> parentIds;
    Handle directory;
    Identity directoryId;
    std::wstring directoryPath, dosPath;
    bool directoryCreated = false;
    std::array<CopyRecord, 3> files;
    std::wstring FilePath(admission::PackageFile file) const {
        const auto index = static_cast<size_t>(file); if (index >= Names.size()) Fail("STAGING_SOURCE_REFUSED");
        return directoryPath + L"\\" + Names[index];
    }
    void CheckParents() const {
        for (size_t i = 0; i < parents.size(); ++i) { if (!Matches(parents[i].value, parentIds[i], true)) Fail("STAGING_PARENT_CHANGED"); Security(parents[i].value, false); }
    }
    void CheckDirectory() const {
        if (!directoryCreated || !Matches(directory.value, directoryId, true)) Fail("STAGING_DIRECTORY_CHANGED");
        Security(directory.value, true);
        if (_wcsicmp(FinalPath(directory.value).c_str(), directoryPath.c_str())) Fail("STAGING_DIRECTORY_CHANGED");
    }
    CleanupResult Cleanup() noexcept {
        if (!directoryCreated) return {true, "CLEANED", ERROR_SUCCESS};
        try {
            RequireElevated(); CheckParents();
            if (!directoryId.valid) Fail("CLEANUP_SCOPE_CHANGED");
            if (directory.value == INVALID_HANDLE_VALUE) directory = OpenDirectory(directoryPath);
            if (!Matches(directory.value, directoryId, true)) Fail("CLEANUP_SCOPE_CHANGED"); Security(directory.value, true);
            for (size_t index = 0; index < files.size(); ++index) {
                auto& record = files[index]; if (!record.created) continue;
                Handle h(CreateFileW(FilePath(static_cast<admission::PackageFile>(index)).c_str(), GENERIC_READ | READ_CONTROL | DELETE,
                    FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
                if (h.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND) { record.created = false; continue; }
                Check(h.value != INVALID_HANDLE_VALUE, "CLEANUP_UNCONFIRMED");
                if (!Matches(h.value, record.id, false)) Fail("CLEANUP_SCOPE_CHANGED"); Security(h.value, true);
                FILE_DISPOSITION_INFO disposition{TRUE}; Check(SetFileInformationByHandle(h.value, FileDispositionInfo, &disposition, sizeof(disposition)), "CLEANUP_UNCONFIRMED");
                h.Reset();
                if (GetFileAttributesW(FilePath(static_cast<admission::PackageFile>(index)).c_str()) != INVALID_FILE_ATTRIBUTES || GetLastError() != ERROR_FILE_NOT_FOUND) Fail("CLEANUP_UNCONFIRMED");
                record.created = false;
            }
            // Admission and our own read directory guard must be closed first.
            directory.Reset(); Handle final = OpenDirectory(directoryPath, DELETE);
            if (!Matches(final.value, directoryId, true)) Fail("CLEANUP_SCOPE_CHANGED"); Security(final.value, true);
            FILE_DISPOSITION_INFO disposition{TRUE}; Check(SetFileInformationByHandle(final.value, FileDispositionInfo, &disposition, sizeof(disposition)), "CLEANUP_UNCONFIRMED");
            final.Reset();
            if (GetFileAttributesW(directoryPath.c_str()) != INVALID_FILE_ATTRIBUTES || GetLastError() != ERROR_FILE_NOT_FOUND) Fail("CLEANUP_UNCONFIRMED");
            directoryCreated = false; return {true, "CLEANED", ERROR_SUCCESS};
        } catch (const Failure& e) { return {false, e.reason, e.code}; }
        catch (...) { return {false, "CLEANUP_UNCONFIRMED", ERROR_UNHANDLED_EXCEPTION}; }
    }
    ~OwnedStage() { Cleanup(); }
};
void InitializeStage(OwnedStage& stage) {
    RequireElevated();
    struct Com { bool release = false; Com() { const HRESULT h = CoInitializeEx(nullptr, COINIT_MULTITHREADED); if (h != S_OK && h != S_FALSE && h != RPC_E_CHANGED_MODE) Fail("STAGING_PARENT_REFUSED", h); release = h == S_OK || h == S_FALSE; } ~Com() { if (release) CoUninitialize(); } } com;
    // This x64 component uses the OS-known application installation directory. Its ACL
    // and retained ancestors must still pass Security(); the name grants no trust.
    PWSTR raw = nullptr; const HRESULT hr = SHGetKnownFolderPath(FOLDERID_ProgramFilesX64, KF_FLAG_DONT_VERIFY, nullptr, &raw);
    struct TaskMemory { PWSTR value; ~TaskMemory() { CoTaskMemFree(value); } } memory{raw};
    if (FAILED(hr) || !raw) Fail("STAGING_PARENT_REFUSED", hr);
    std::wstring path(raw);
    if (path.size() < 4 || path.size() > 140 || path[1] != L':' || path[2] != L'\\' || path.back() == L'\\' || path.find_first_of(L"/:~\"<>|?*", 2) != std::wstring::npos) Fail("STAGING_PATH_REFUSED");
    if (GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED) Fail("STAGING_PATH_REFUSED");
    stage.parents.push_back(OpenDirectory(path.substr(0, 3))); const auto volume = FinalPath(stage.parents.front().value);
    if (volume.rfind(L"\\\\?\\Volume{", 0) != 0 || volume.size() != 49 || volume.substr(47) != L"}\\") Fail("STAGING_PATH_REFUSED");
    DWORD flags = 0; Check(GetVolumeInformationW(volume.c_str(), nullptr, 0, nullptr, nullptr, &flags, nullptr, 0), "STAGING_PARENT_REFUSED");
    if (!(flags & FILE_PERSISTENT_ACLS)) Fail("STAGING_SECURITY_REFUSED");
    const auto parent = volume + path.substr(3);
    for (size_t end = volume.size(); end <= parent.size(); ++end) { if (end != parent.size() && parent[end] != L'\\') continue;
        stage.parents.push_back(OpenDirectory(parent.substr(0, end))); }
    for (const auto& h : stage.parents) { Security(h.value, false); stage.parentIds.push_back(Identify(h.value, true)); }
    std::array<BYTE, 16> nonce{}; const NTSTATUS random = BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (random < 0) Fail("STAGING_RANDOM_FAILED", random);
    constexpr wchar_t hex[] = L"0123456789abcdef"; std::wstring name = L"ReviewOpsDriverStage-";
    for (BYTE b : nonce) { name += hex[b >> 4]; name += hex[b & 15]; }
    stage.directoryPath = parent + L"\\" + name; Descriptor descriptor(true);
    Check(CreateDirectoryW(stage.directoryPath.c_str(), &descriptor.attributes), "STAGING_CREATE_FAILED"); stage.directoryCreated = true;
    stage.directory = OpenDirectory(stage.directoryPath); stage.directoryId = Identify(stage.directory.value, true); Security(stage.directory.value, true);
    if (_wcsicmp(FinalPath(stage.directory.value).c_str(), stage.directoryPath.c_str())) Fail("STAGING_PATH_REFUSED");
    stage.dosPath = FinalPath(stage.directory.value, VOLUME_NAME_DOS);
    if (stage.dosPath.rfind(L"\\\\?\\", 0) != 0) Fail("STAGING_PATH_REFUSED"); stage.dosPath.erase(0, 4);
}
std::unique_ptr<OwnedStage> CreateStage() {
    auto stage = std::make_unique<OwnedStage>(); InitializeStage(*stage); return stage;
}
void CopyFileFromHandle(OwnedStage& stage, admission::PackageFile file, HANDLE source) {
    RequireElevated(); stage.CheckParents(); stage.CheckDirectory(); const auto index = static_cast<size_t>(file);
    if (index >= Names.size() || stage.files[index].created) Fail("STAGING_SOURCE_REFUSED");
    const auto before = Information(source, false); const auto sourceId = Identify(source, false);
    if (!Size(before) || Size(before) > Limits[index]) Fail("STAGING_SOURCE_REFUSED");
    const auto expected = Digest(source, Limits[index]); Descriptor descriptor(false);
    Handle target(CreateFileW(stage.FilePath(file).c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ, &descriptor.attributes,
        CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
    Check(target.value != INVALID_HANDLE_VALUE, "STAGING_CREATE_FAILED");
    auto& record = stage.files[index]; record.created = true; record.id = Identify(target.value, false); Security(target.value, true);
    LARGE_INTEGER zero{}; Check(SetFilePointerEx(source, zero, nullptr, FILE_BEGIN), "STAGING_COPY_FAILED");
    std::array<BYTE, 65536> bytes{}; uint64_t copied = 0;
    for (;;) { DWORD count = 0; Check(ReadFile(source, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr), "STAGING_COPY_FAILED");
        if (!count) break; copied += count; if (copied > Size(before)) Fail("STAGING_SOURCE_CHANGED");
        DWORD offset = 0; while (offset < count) { DWORD written = 0; Check(WriteFile(target.value, bytes.data() + offset, count - offset, &written, nullptr), "STAGING_COPY_FAILED");
            if (!written || written > count - offset) Fail("STAGING_COPY_FAILED"); offset += written; }
    }
    Check(FlushFileBuffers(target.value), "STAGING_FLUSH_FAILED");
    if (copied != Size(before) || !Matches(source, sourceId, false) || Digest(source, Limits[index]) != expected || Digest(target.value, Limits[index]) != expected) Fail("STAGING_SOURCE_CHANGED");
    record.size = copied; record.hash = expected;
    // Closing the write handle is necessary for InspectPackage's read-only sharing.
}
void CheckCopiedStage(OwnedStage& stage) {
    stage.CheckParents(); stage.CheckDirectory();
    WIN32_FIND_DATAW data{}; HANDLE search = FindFirstFileW((stage.directoryPath + L"\\*").c_str(), &data);
    Check(search != INVALID_HANDLE_VALUE, "STAGING_OPEN_FAILED"); size_t entries = 0; bool bad = false; DWORD error = ERROR_SUCCESS;
    do { if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L"..")) continue;
        ++entries; bool known = false; for (const auto name : Names) known = known || !_wcsicmp(name, data.cFileName);
        if (!known || (data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) { bad = true; break; }
    } while (FindNextFileW(search, &data));
    if (!bad) error = GetLastError(); FindClose(search);
    if (bad || error != ERROR_NO_MORE_FILES || entries != Names.size()) Fail("STAGING_UNEXPECTED_ENTRIES", static_cast<LONG>(error));
    for (size_t index = 0; index < Names.size(); ++index) {
        const auto& record = stage.files[index]; if (!record.created || record.hash.empty()) Fail("STAGING_COPY_INCOMPLETE");
        Handle h(CreateFileW(stage.FilePath(static_cast<admission::PackageFile>(index)).c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); Check(h.value != INVALID_HANDLE_VALUE, "STAGING_OPEN_FAILED");
        if (!Matches(h.value, record.id, false) || Size(Information(h.value, false)) != record.size || Digest(h.value, Limits[index]) != record.hash) Fail("STAGING_COPY_CHANGED"); Security(h.value, true);
    }
}
} // namespace internal

struct StagedPackage::Impl {
    std::unique_ptr<admission::VerifiedPackage> source, verified;
    std::unique_ptr<internal::OwnedStage> stage;
};
StagedPackage::StagedPackage(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}
StagedPackage::~StagedPackage() { Cleanup(); }
StagedPackage::StagedPackage(StagedPackage&&) noexcept = default;
bool StagedPackage::Ready() const noexcept { return impl_ && impl_->verified != nullptr; }
const admission::VerifiedPackage* StagedPackage::Verified() const noexcept { return Ready() ? impl_->verified.get() : nullptr; }
std::wstring StagedPackage::InternalInfPath() const { return Revalidate() ? impl_->stage->FilePath(admission::PackageFile::Inf) : std::wstring{}; }
bool StagedPackage::Revalidate() const noexcept {
    try { if (!Ready() || !impl_->source->Revalidate() || !impl_->verified->Revalidate()) return false;
        internal::RequireElevated(); internal::CheckCopiedStage(*impl_->stage); return true; } catch (...) { return false; }
}
CleanupResult StagedPackage::Cleanup() noexcept {
    if (!impl_) return {true, "CLEANED", ERROR_SUCCESS};
    impl_->verified.reset(); if (!impl_->stage) return {true, "CLEANED", ERROR_SUCCESS};
    return impl_->stage->Cleanup();
}
StagingResult StageVerifiedPackage(admission::VerifiedPackage&& source) {
    StagingResult result;
    try {
        internal::RequireElevated();
        if (!source.Revalidate()) internal::Fail("STAGING_SOURCE_REFUSED");
        auto impl = std::make_unique<StagedPackage::Impl>();
        impl->source = std::make_unique<admission::VerifiedPackage>(std::move(source));
        result.owner = std::unique_ptr<StagedPackage>(new StagedPackage(std::move(impl)));
        auto& state = *result.owner->impl_; state.stage = std::make_unique<internal::OwnedStage>(); internal::InitializeStage(*state.stage);
        for (size_t index = 0; index < internal::Names.size(); ++index) internal::CopyFileFromHandle(*state.stage, static_cast<admission::PackageFile>(index), state.source->FileHandle(static_cast<admission::PackageFile>(index)));
        if (!state.source->Revalidate()) internal::Fail("STAGING_SOURCE_CHANGED"); internal::CheckCopiedStage(*state.stage);
        auto inspection = admission::InspectPackage(state.stage->dosPath);
        if (!inspection.package) internal::Fail(inspection.reason, inspection.nativeCode);
        if (!internal::Matches(inspection.package->DirectoryHandle(), state.stage->directoryId, true)) internal::Fail("STAGING_DIRECTORY_CHANGED");
        for (size_t index = 0; index < internal::Names.size(); ++index) {
            if (!internal::Matches(inspection.package->FileHandle(static_cast<admission::PackageFile>(index)), state.stage->files[index].id, false) ||
                inspection.files[index].sha256 != state.stage->files[index].hash || inspection.files[index].size != state.stage->files[index].size) internal::Fail("STAGING_COPY_CHANGED");
        }
        state.verified = std::move(inspection.package);
        if (!result.owner->Revalidate()) internal::Fail("STAGING_COPY_CHANGED");
        result.ready = true; result.reason = "STAGED";
    } catch (const internal::Failure& e) { result.reason = e.reason; result.nativeCode = e.code; }
    catch (...) { result.reason = "STAGING_FAILED"; result.nativeCode = ERROR_UNHANDLED_EXCEPTION; }
    if (!result.ready && result.owner) {
        const auto cleanup = result.owner->Cleanup(); result.cleanupComplete = cleanup.complete;
        if (cleanup.complete) result.owner.reset();
    }
    return result;
}
} // namespace reviewops::display::staging
