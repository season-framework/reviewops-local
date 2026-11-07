// This dedicated translation unit exercises the real private copy/cleanup
// primitives. It never constructs a VerifiedPackage or changes driver trust.
#ifndef REVIEWOPS_STAGING_TESTS
#define REVIEWOPS_STAGING_TESTS
#endif
#include "PackageStaging.cpp"

#include <cstdio>
#include <cstring>
#include <functional>

namespace {
namespace admission = reviewops::display::admission;
namespace staging = reviewops::display::staging;
namespace impl = reviewops::display::staging::internal;
using File = admission::PackageFile;

struct TestFailure { const char* reason; LONG code; };
[[noreturn]] void FailTest(const char* reason, DWORD code = ERROR_SUCCESS) {
    throw TestFailure{reason, static_cast<LONG>(code)};
}
void Need(bool condition, const char* reason) { if (!condition) FailTest(reason, GetLastError()); }
bool cleanupComplete = true;
std::string observations;
void Observe(const char* name, uint64_t value) {
    std::array<char, 128> text{};
    std::snprintf(text.data(), text.size(), "%s\"%s\":%llu", observations.empty() ? "" : ",", name, static_cast<unsigned long long>(value));
    observations += text.data();
}
void ObserveReason(const char* name, const char* value) {
    observations += observations.empty() ? "" : ",";
    observations += std::string("\"") + name + "\":\"" + value + "\"";
}

struct FileIdentity {
    ULONGLONG volume = 0;
    FILE_ID_128 file{};
};
FileIdentity FileId(HANDLE handle) {
    BY_HANDLE_FILE_INFORMATION info{};
    Need(GetFileInformationByHandle(handle, &info) != FALSE, "TEST_IDENTITY_FAILED");
    Need(GetFileType(handle) == FILE_TYPE_DISK && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "TEST_UNSAFE_OBJECT");
    FILE_ID_INFO identity{};
    Need(GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity)) != FALSE, "TEST_IDENTITY_FAILED");
    return {identity.VolumeSerialNumber, identity.FileId};
}
bool SameId(const FileIdentity& left, const FileIdentity& right) {
    return left.volume == right.volume && std::memcmp(left.file.Identifier, right.file.Identifier, sizeof(left.file.Identifier)) == 0;
}
std::wstring BoundPath(HANDLE handle) {
    std::array<wchar_t, 512> buffer{};
    const DWORD count = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
    Need(count != 0 && count < buffer.size(), "TEST_BOUND_PATH_FAILED");
    return std::wstring(buffer.data(), count);
}
impl::Handle ReadOnly(const std::wstring& path, DWORD sharing = FILE_SHARE_READ) {
    impl::Handle handle(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, sharing, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Need(handle.value != INVALID_HANDLE_VALUE, "TEST_READ_OPEN_FAILED");
    FileId(handle.value);
    return handle;
}
uint64_t ExactBytes(HANDLE handle, const std::vector<BYTE>& expected) {
    LARGE_INTEGER zero{}, size{};
    Need(GetFileSizeEx(handle, &size) != FALSE && size.QuadPart >= 0 && static_cast<uint64_t>(size.QuadPart) == expected.size(), "TEST_SIZE_DIFFERENT");
    Need(SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) != FALSE, "TEST_SEEK_FAILED");
    std::array<BYTE, 8192> buffer{};
    size_t offset = 0;
    for (;;) {
        DWORD count = 0;
        Need(ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) != FALSE, "TEST_READ_FAILED");
        if (!count) break;
        Need(offset + count <= expected.size() && std::memcmp(buffer.data(), expected.data() + offset, count) == 0, "TEST_BYTES_DIFFERENT");
        offset += count;
    }
    Need(offset == expected.size(), "TEST_SHORT_READ");
    Need(SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) != FALSE, "TEST_SEEK_FAILED");
    return offset;
}
std::vector<BYTE> Data(size_t bytes, BYTE seed) {
    std::vector<BYTE> result(bytes);
    for (size_t index = 0; index < bytes; ++index) result[index] = static_cast<BYTE>((index * 17 + seed) & 255);
    return result;
}
bool Absent(const std::wstring& path) noexcept;
FileIdentity CreateBytes(const std::wstring& path, const std::vector<BYTE>& bytes) {
    impl::Descriptor descriptor(false);
    impl::Handle handle(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE, FILE_SHARE_READ,
        &descriptor.attributes, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Need(handle.value != INVALID_HANDLE_VALUE, "TEST_CREATE_FAILED");
    FileIdentity id;
    try {
        id = FileId(handle.value);
        size_t offset = 0;
        while (offset < bytes.size()) {
            const DWORD count = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, 65536));
            DWORD written = 0;
            Need(WriteFile(handle.value, bytes.data() + offset, count, &written, nullptr) != FALSE && written > 0 && written <= count, "TEST_WRITE_FAILED");
            offset += written;
        }
        Need(FlushFileBuffers(handle.value) != FALSE, "TEST_FLUSH_FAILED");
        ExactBytes(handle.value, bytes);
    } catch (...) {
        FILE_DISPOSITION_INFO disposition{TRUE};
        const BOOL marked = SetFileInformationByHandle(handle.value, FileDispositionInfo, &disposition, sizeof(disposition));
        handle.Reset();
        if (!marked || !Absent(path)) cleanupComplete = false;
        throw;
    }
    return id;
}
bool Absent(const std::wstring& path) noexcept {
    if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}
bool RemoveKnown(const std::wstring& path, const FileIdentity& original) noexcept {
    try {
        impl::Handle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (handle.value == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
        if (!SameId(FileId(handle.value), original)) return false;
        FILE_DISPOSITION_INFO disposition{TRUE};
        if (!SetFileInformationByHandle(handle.value, FileDispositionInfo, &disposition, sizeof(disposition))) return false;
        handle.Reset();
        return Absent(path);
    } catch (...) { return false; }
}
DWORD ExactPrivateAcl(HANDLE handle) {
    PSID owner = nullptr;
    PACL acl = nullptr;
    impl::LocalMemory descriptor;
    const DWORD error = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    Need(error == ERROR_SUCCESS, "TEST_SECURITY_QUERY_FAILED");
    Need(owner && IsWellKnownSid(owner, WinBuiltinAdministratorsSid) && acl && IsValidAcl(acl) && acl->AceCount == 2, "TEST_OWNER_OR_ACL_DIFFERENT");
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    Need(GetSecurityDescriptorControl(descriptor.value, &control, &revision) != FALSE && (control & SE_DACL_PROTECTED), "TEST_DACL_NOT_PROTECTED");
    bool system = false, administrators = false;
    for (DWORD index = 0; index < acl->AceCount; ++index) {
        PVOID raw = nullptr;
        Need(GetAce(acl, index, &raw) != FALSE, "TEST_ACE_QUERY_FAILED");
        const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
        Need(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Mask == FILE_ALL_ACCESS &&
            !(ace->Header.AceFlags & (INHERITED_ACE | INHERIT_ONLY_ACE)), "TEST_ACE_DIFFERENT");
        PSID sid = const_cast<DWORD*>(&ace->SidStart);
        const bool isSystem = IsWellKnownSid(sid, WinLocalSystemSid) != FALSE;
        const bool isAdministrators = IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != FALSE;
        Need(isSystem || isAdministrators, "TEST_UNEXPECTED_PRINCIPAL");
        system = system || isSystem;
        administrators = administrators || isAdministrators;
    }
    Need(system && administrators, "TEST_REQUIRED_PRINCIPAL_MISSING");
    return acl->AceCount;
}
struct StageOwner {
    std::unique_ptr<impl::OwnedStage> value;
    StageOwner() : value(std::make_unique<impl::OwnedStage>()) {
        try { impl::InitializeStage(*value); }
        catch (...) {
            if (!value->Cleanup().complete) cleanupComplete = false;
            throw;
        }
    }
    bool Close() {
        if (!value) return true;
        const auto result = value->Cleanup();
        if (!result.complete) return false;
        value.reset();
        return true;
    }
    ~StageOwner() { if (value && !value->Cleanup().complete) cleanupComplete = false; }
};
struct Fixtures {
    std::wstring directory;
    impl::Handle guard;
    FileIdentity directoryId;
    bool created = false;
    std::array<std::vector<BYTE>, 4> bytes;
    std::array<FileIdentity, 4> identities{};
    std::array<bool, 4> present{};
    std::array<impl::Handle, 3> sources;
    const std::array<const wchar_t*, 4> names = {L"source-inf.bin", L"source-dll.bin", L"source-cat.bin", L"sibling-sentinel.bin"};
    explicit Fixtures(size_t infSize = 101) {
        impl::RequireElevated();
        try {
            std::array<wchar_t, 512> temp{};
            const DWORD length = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
            Need(length && length < temp.size(), "TEST_TEMP_UNAVAILABLE");
            std::array<BYTE, 16> nonce{};
            Need(BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0, "TEST_RANDOM_FAILED");
            directory.assign(temp.data(), length);
            directory += L"ReviewOpsStagingFixture-";
            constexpr wchar_t hex[] = L"0123456789abcdef";
            for (BYTE item : nonce) { directory += hex[item >> 4]; directory += hex[item & 15]; }
            impl::Descriptor descriptor(true);
            Need(CreateDirectoryW(directory.c_str(), &descriptor.attributes) != FALSE, "TEST_FIXTURE_DIRECTORY_FAILED");
            created = true;
            guard = impl::OpenDirectory(directory, DELETE);
            directoryId = FileId(guard.value);
            directory = BoundPath(guard.value);
            bytes = {Data(infSize, 11), Data(70003, 29), Data(513, 47), Data(97, 83)};
            for (size_t index = 0; index < names.size(); ++index) {
                identities[index] = CreateBytes(Path(index), bytes[index]);
                present[index] = true;
            }
            for (size_t index = 0; index < sources.size(); ++index) sources[index] = ReadOnly(Path(index));
        } catch (...) { if (!Close()) cleanupComplete = false; throw; }
    }
    std::wstring Path(size_t index) const { return directory + L"\\" + names[index]; }
    void Preserved() {
        for (size_t index = 0; index < sources.size(); ++index) {
            Need(SameId(FileId(sources[index].value), identities[index]), "TEST_SOURCE_IDENTITY_CHANGED");
            ExactBytes(sources[index].value, bytes[index]);
        }
        auto sentinel = ReadOnly(Path(3));
        Need(SameId(FileId(sentinel.value), identities[3]), "TEST_SIBLING_IDENTITY_CHANGED");
        ExactBytes(sentinel.value, bytes[3]);
    }
    bool Close() noexcept {
        for (auto& source : sources) source.Reset();
        if (!created) return true;
        bool complete = true;
        for (size_t index = 0; index < names.size(); ++index) {
            if (present[index] && RemoveKnown(Path(index), identities[index])) present[index] = false;
            complete = complete && !present[index];
        }
        if (!complete) return false;
        try {
            if (!SameId(FileId(guard.value), directoryId)) return false;
            FILE_DISPOSITION_INFO disposition{TRUE};
            if (!SetFileInformationByHandle(guard.value, FileDispositionInfo, &disposition, sizeof(disposition))) return false;
            guard.Reset();
            if (!Absent(directory)) return false;
            created = false; return true;
        } catch (...) { return false; }
    }
    ~Fixtures() { if (!Close()) cleanupComplete = false; }
};
void CopyAll(StageOwner& stage, Fixtures& fixtures) {
    for (size_t index = 0; index < fixtures.sources.size(); ++index)
        impl::CopyFileFromHandle(*stage.value, static_cast<File>(index), fixtures.sources[index].value);
    impl::CheckCopiedStage(*stage.value);
}
void CopiesEqual(StageOwner& stage, const Fixtures& fixtures) {
    uint64_t compared = 0;
    size_t count = 0;
    for (size_t index = 0; index < fixtures.sources.size(); ++index) {
        auto output = ReadOnly(stage.value->FilePath(static_cast<File>(index)));
        ExactPrivateAcl(output.value);
        compared += ExactBytes(output.value, fixtures.bytes[index]);
        Need(!SameId(FileId(output.value), fixtures.identities[index]), "TEST_COPY_ALIASES_SOURCE");
        ++count;
    }
    Observe("matchedFiles", count); Observe("comparedBytes", compared);
}
template<typename Operation> impl::Failure Refuses(Operation operation, const char* expected) {
    try { operation(); }
    catch (const impl::Failure& failure) { ObserveReason("refusal", failure.reason); Observe("refusalCode", static_cast<DWORD>(failure.code)); Need(std::strcmp(failure.reason, expected) == 0, "TEST_REFUSAL_DIFFERENT"); return failure; }
    FailTest("TEST_EXPECTED_REFUSAL_MISSING");
}
struct Impersonation {
    bool active = false;
    Impersonation() {
        HANDLE processRaw = nullptr;
        Need(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &processRaw) != FALSE, "TEST_PROCESS_TOKEN_FAILED");
        impl::Handle process(processRaw);
        HANDLE copyRaw = nullptr;
        Need(DuplicateTokenEx(process.value, TOKEN_QUERY | TOKEN_IMPERSONATE, nullptr, SecurityImpersonation, TokenImpersonation, &copyRaw) != FALSE, "TEST_DUPLICATE_TOKEN_FAILED");
        impl::Handle copy(copyRaw);
        Need(SetThreadToken(nullptr, copy.value) != FALSE, "TEST_IMPERSONATION_FAILED");
        active = true;
    }
    void Revert() {
        if (active && !RevertToSelf()) {
            std::fputs("TEST_FATAL_REVERT_FAILED\n", stderr);
            ExitProcess(3);
        }
        active = false;
    }
    ~Impersonation() { Revert(); }
};
struct Case {
    const char* name;
    const char* operation;
    const char* scope;
    std::function<void()> run;
};
} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || wcscmp(argv[1], L"--self-test")) {
        std::puts("{\"type\":\"summary\",\"version\":1,\"status\":\"failed\",\"reason\":\"INVALID_ARGUMENT\",\"cleanupComplete\":true,\"positiveSignedProductionStageTested\":false,\"driverInstalled\":false,\"displayChanged\":false}");
        return 2;
    }
    const std::array<Case, 9> cases = {{
        {"elevated-process-context", "RequireElevated", "Actual elevated process and no thread impersonation", [] {
            impl::RequireElevated();
            Observe("gateReturned", 1);
        }},
        {"impersonated-thread-refused", "DuplicateTokenEx + SetThreadToken + RequireElevated + RevertToSelf", "Rejects the test process impersonating its own identity before any staging", [] {
            impl::RequireElevated();
            { Impersonation impersonation; Refuses([] { impl::RequireElevated(); }, "STAGING_IMPERSONATION_REFUSED"); impersonation.Revert(); }
            impl::RequireElevated();
            Observe("restoredGateReturned", 1);
        }},
        {"protected-stage-acl", "CreateStage + independent GetSecurityInfo + Cleanup", "Real fresh native Program Files directory, production owner/DACL and volume-bound identity", [] {
            StageOwner stage;
            Observe("aceCount", ExactPrivateAcl(stage.value->directory.value));
            Need(BoundPath(stage.value->directory.value) == stage.value->directoryPath && stage.value->directoryPath.rfind(L"\\\\?\\Volume{", 0) == 0, "TEST_STAGE_PATH_DIFFERENT");
            Need(stage.Close(), "TEST_STAGE_CLEANUP_FAILED");
            Observe("cleanupConfirmed", 1);
        }},
        {"retained-handle-copy", "CopyFileFromHandle x3 + independent byte/ACL comparisons + Cleanup", "Arbitrary owned fixture bytes only; no signed production admission", [] {
            Fixtures fixtures;
            StageOwner stage;
            CopyAll(stage, fixtures); CopiesEqual(stage, fixtures); fixtures.Preserved();
            Need(stage.Close(), "TEST_STAGE_CLEANUP_FAILED"); fixtures.Preserved();
            Need(fixtures.Close(), "TEST_FIXTURE_CLEANUP_FAILED");
            Observe("sourceAndSiblingPreserved", 1); Observe("cleanupConfirmed", 1);
        }},
        {"empty-source-refused", "CopyFileFromHandle with zero-byte INF fixture", "Refuses before destination creation; original fixtures preserved", [] {
            Fixtures fixtures(0); StageOwner stage;
            Refuses([&] { impl::CopyFileFromHandle(*stage.value, File::Inf, fixtures.sources[0].value); }, "STAGING_SOURCE_REFUSED");
            Need(!stage.value->files[0].created, "TEST_REFUSAL_CREATED_DESTINATION"); fixtures.Preserved();
            Need(stage.Close() && fixtures.Close(), "TEST_OWNED_CLEANUP_FAILED");
            Observe("destinationCreated", 0); Observe("sourceBytes", 0); Observe("cleanupConfirmed", 1);
        }},
        {"oversize-source-refused", "CopyFileFromHandle with 65537-byte INF fixture", "Refuses an INF above its 65536-byte bound before destination creation", [] {
            Fixtures fixtures(65537); StageOwner stage;
            Refuses([&] { impl::CopyFileFromHandle(*stage.value, File::Inf, fixtures.sources[0].value); }, "STAGING_SOURCE_REFUSED");
            Need(!stage.value->files[0].created, "TEST_REFUSAL_CREATED_DESTINATION"); fixtures.Preserved();
            Need(stage.Close() && fixtures.Close(), "TEST_OWNED_CLEANUP_FAILED");
            Observe("destinationCreated", 0); Observe("sourceBytes", 65537); Observe("cleanupConfirmed", 1);
        }},
        {"extra-entry-refused-and-preserved", "CheckCopiedStage + Cleanup with an untracked owned-test entry", "Rejects the extra entry and preserves it; test removes only its own recorded entry before cleanup retry", [] {
            Fixtures fixtures; StageOwner stage; CopyAll(stage, fixtures);
            const auto path = stage.value->directoryPath + L"\\untracked-test-entry.bin";
            const auto bytes = Data(211, 107); const auto id = CreateBytes(path, bytes);
            try {
                Refuses([&] { impl::CheckCopiedStage(*stage.value); }, "STAGING_UNEXPECTED_ENTRIES");
                const auto initialCleanup = stage.value->Cleanup();
                Observe("initialCleanupComplete", initialCleanup.complete ? 1 : 0); ObserveReason("cleanupReason", initialCleanup.reason); Observe("cleanupCode", static_cast<DWORD>(initialCleanup.nativeCode));
                Need(!initialCleanup.complete, "TEST_FOREIGN_ENTRY_WAS_REMOVED");
                { auto observer = ReadOnly(path); Need(SameId(FileId(observer.value), id), "TEST_FOREIGN_ENTRY_REPLACED"); Observe("preservedEntryBytes", ExactBytes(observer.value, bytes)); }
                fixtures.Preserved();
                Need(RemoveKnown(path, id), "TEST_ENTRY_CLEANUP_FAILED");
                Need(stage.Close() && fixtures.Close(), "TEST_OWNED_CLEANUP_FAILED");
                Observe("cleanupConfirmed", 1);
            } catch (...) { if (!RemoveKnown(path, id)) cleanupComplete = false; throw; }
        }},
        {"staged-mutation-fences", "Retain actual read/share-read handles; attempt write/delete/rename", "Kernel handle fence primitive only; no VerifiedPackage or signed production stage is constructed", [] {
            Fixtures fixtures; StageOwner stage; CopyAll(stage, fixtures);
            {
                std::array<impl::Handle, 3> fences;
                for (size_t index = 0; index < fences.size(); ++index) fences[index] = ReadOnly(stage.value->FilePath(static_cast<File>(index)));
                const auto path = stage.value->FilePath(File::Inf);
                impl::Handle writer(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
                const DWORD writeError = GetLastError();
                Observe("writeError", writeError);
                Need(writer.value == INVALID_HANDLE_VALUE && writeError == ERROR_SHARING_VIOLATION, "TEST_WRITE_FENCE_MISSING");
                const BOOL deleted = DeleteFileW(path.c_str()); const DWORD deleteError = GetLastError();
                Observe("deleteError", deleteError);
                Need(!deleted && deleteError == ERROR_SHARING_VIOLATION, "TEST_DELETE_FENCE_MISSING");
                const BOOL renamed = MoveFileExW(path.c_str(), (stage.value->directoryPath + L"\\renamed-test-inf.bin").c_str(), 0); const DWORD renameError = GetLastError();
                Observe("renameError", renameError);
                Need(!renamed && renameError == ERROR_SHARING_VIOLATION, "TEST_RENAME_FENCE_MISSING");
                impl::CheckCopiedStage(*stage.value);
                for (size_t index = 0; index < fences.size(); ++index) ExactBytes(fences[index].value, fixtures.bytes[index]);
            }
            fixtures.Preserved(); Need(stage.Close() && fixtures.Close(), "TEST_OWNED_CLEANUP_FAILED");
            Observe("cleanupConfirmed", 1);
        }},
        {"cleanup-identity-mismatch-preserves-replacement", "Replace an owned pre-admission copy with an independently tracked test file; Cleanup", "Checks cleanup identity refusal before admission, preserving replacement and independent sibling", [] {
            Fixtures fixtures; StageOwner stage; CopyAll(stage, fixtures);
            const auto path = stage.value->FilePath(File::Inf);
            FileIdentity original;
            { auto handle = ReadOnly(path); original = FileId(handle.value); }
            Need(RemoveKnown(path, original), "TEST_ORIGINAL_RETIRE_FAILED");
            const auto bytes = Data(317, 151); const auto replacement = CreateBytes(path, bytes);
            try {
                Need(!SameId(original, replacement), "TEST_REPLACEMENT_ID_NOT_DISTINCT");
                {
                    auto observer = ReadOnly(path, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
                    const auto result = stage.value->Cleanup();
                    Observe("initialCleanupComplete", result.complete ? 1 : 0); ObserveReason("cleanupReason", result.reason); Observe("cleanupCode", static_cast<DWORD>(result.nativeCode));
                    Need(!result.complete && !std::strcmp(result.reason, "CLEANUP_SCOPE_CHANGED"), "TEST_IDENTITY_MISMATCH_NOT_REFUSED");
                    Need(SameId(FileId(observer.value), replacement), "TEST_REPLACEMENT_ID_CHANGED"); Observe("preservedReplacementBytes", ExactBytes(observer.value, bytes));
                }
                fixtures.Preserved();
                Need(RemoveKnown(path, replacement), "TEST_REPLACEMENT_CLEANUP_FAILED");
                Need(stage.Close() && fixtures.Close(), "TEST_OWNED_CLEANUP_FAILED");
                Observe("sourceAndSiblingPreserved", 1); Observe("cleanupConfirmed", 1);
            } catch (...) { if (!RemoveKnown(path, replacement)) cleanupComplete = false; throw; }
        }}
    }};
    size_t passed = 0, failed = 0;
    for (const auto& test : cases) {
        bool ok = true; const char* reason = "EXPECTED_NATIVE_OBSERVATIONS"; LONG nativeCode = ERROR_SUCCESS;
        const ULONGLONG started = GetTickCount64();
        observations.clear();
        try { test.run(); }
        catch (const TestFailure& error) { ok = false; reason = error.reason; nativeCode = error.code; }
        catch (const impl::Failure& error) { ok = false; reason = error.reason; nativeCode = error.code; }
        catch (...) { ok = false; reason = "TEST_UNHANDLED_FAILURE"; nativeCode = ERROR_UNHANDLED_EXCEPTION; }
        if (ok) ++passed; else ++failed;
        std::printf("{\"type\":\"case\",\"name\":\"%s\",\"status\":\"%s\",\"operation\":\"%s\",\"scope\":\"%s\",\"reason\":\"%s\",\"nativeCode\":%ld,\"observations\":{%s},\"elapsedMs\":%llu}\n",
            test.name, ok ? "passed" : "failed", test.operation, test.scope, reason, nativeCode, observations.c_str(), static_cast<unsigned long long>(GetTickCount64() - started));
        std::fflush(stdout);
    }
    const bool success = failed == 0 && cleanupComplete;
    std::printf("{\"type\":\"summary\",\"version\":1,\"status\":\"%s\",\"counts\":{\"passed\":%zu,\"failed\":%zu,\"total\":%zu},\"cleanupComplete\":%s,\"positiveSignedProductionStageTested\":false,\"driverInstalled\":false,\"displayChanged\":false}\n",
        success ? "passed-staging-primitives-only" : "failed", passed, failed, cases.size(), cleanupComplete ? "true" : "false");
    return success ? 0 : 1;
}
