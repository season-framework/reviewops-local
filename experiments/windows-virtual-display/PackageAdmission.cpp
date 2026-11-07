#include "PackageAdmission.h"

#include <bcrypt.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <mscat.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <cwctype>
#include <utility>
#include <vector>

namespace reviewops::display::admission {
namespace {
constexpr std::array<const wchar_t*, 3> Names = {
    L"ReviewOpsVirtualDisplay.inf", L"ReviewOpsVirtualDisplay.dll", L"reviewopsvirtualdisplay.cat"};
constexpr std::array<const char*, 3> PublicNames = {
    "ReviewOpsVirtualDisplay.inf", "ReviewOpsVirtualDisplay.dll", "reviewopsvirtualdisplay.cat"};
constexpr std::array<const char*, 2> ApprovedHashes = {
    "68cbc49405e2165ad6053f76727e25de540413c9feebc42063bdb1e3ae30c863",
    "f8d77b15537470fa33e8b32633c8b3a600e4a9a1b85a00a4a1ea1916619c2eee"};
constexpr std::array<uint64_t, 3> Limits = {64 * 1024, 16 * 1024 * 1024, 4 * 1024 * 1024};
struct Refusal { const char* reason; LONG code; };
[[noreturn]] void Refuse(const char* reason, LONG code = ERROR_SUCCESS) { throw Refusal{reason, code}; }
void Check(bool value, const char* reason) { if (!value) Refuse(reason, static_cast<LONG>(GetLastError())); }

struct Opened {
    HANDLE handle = INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION identity{};
    Opened() = default;
    ~Opened() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
    Opened(Opened&& other) noexcept : handle(std::exchange(other.handle, INVALID_HANDLE_VALUE)), identity(other.identity) {}
    Opened& operator=(Opened&& other) noexcept {
        if (this != &other) { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); handle = std::exchange(other.handle, INVALID_HANDLE_VALUE); identity = other.identity; }
        return *this;
    }
    Opened(const Opened&) = delete;
    Opened& operator=(const Opened&) = delete;
};
uint64_t Size(const BY_HANDLE_FILE_INFORMATION& value) { return (uint64_t(value.nFileSizeHigh) << 32) | value.nFileSizeLow; }
bool Same(const Opened& original, bool directory = false) {
    BY_HANDLE_FILE_INFORMATION current{};
    if (!GetFileInformationByHandle(original.handle, &current)) return false;
    const auto& old = original.identity;
    return current.dwVolumeSerialNumber == old.dwVolumeSerialNumber && current.nFileIndexHigh == old.nFileIndexHigh &&
        current.nFileIndexLow == old.nFileIndexLow && current.dwFileAttributes == old.dwFileAttributes &&
        (directory || (current.nNumberOfLinks == old.nNumberOfLinks && Size(current) == Size(old) &&
        CompareFileTime(&current.ftLastWriteTime, &old.ftLastWriteTime) == 0));
}
Opened Open(const std::wstring& path, bool directory, uint64_t limit) {
    Opened result;
    result.handle = CreateFileW(path.c_str(), directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
    Check(result.handle != INVALID_HANDLE_VALUE, "OPEN_FAILED");
    Check(GetFileInformationByHandle(result.handle, &result.identity) != FALSE, "OPEN_FAILED");
    const DWORD attributes = result.identity.dwFileAttributes;
    if (GetFileType(result.handle) != FILE_TYPE_DISK || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(attributes & FILE_ATTRIBUTE_DIRECTORY) != directory) Refuse(directory ? "UNSAFE_PATH" : "UNSAFE_FILE");
    if (!directory && (result.identity.nNumberOfLinks != 1 || Size(result.identity) == 0 || Size(result.identity) > limit)) Refuse("UNSAFE_FILE");
    return result;
}
std::wstring BoundPath(HANDLE original) {
    std::array<wchar_t, 512> buffer{};
    const DWORD length = GetFinalPathNameByHandleW(original, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
    if (!length || length >= buffer.size()) Refuse("UNSAFE_PATH", static_cast<LONG>(GetLastError()));
    return std::wstring(buffer.data(), length);
}
std::wstring AdmitPath(const std::wstring& value) {
    if (value.size() < 4 || value.size() > 220 || !((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) ||
        value[1] != L':' || value[2] != L'\\' || value.back() == L'\\') Refuse("UNSAFE_PATH");
    size_t begin = 3;
    for (size_t i = 3; i <= value.size(); ++i) {
        if (i != value.size() && value[i] != L'\\') {
            const wchar_t ch = value[i];
            if (ch < 32 || ch == 127 || ch == L'/' || ch == L':' || ch == L'"' || ch == L'<' || ch == L'>' || ch == L'|' || ch == L'*' || ch == L'?' || ch == L'~') Refuse("UNSAFE_PATH");
            continue;
        }
        const auto part = value.substr(begin, i - begin);
        if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') Refuse("UNSAFE_PATH");
        const auto stem = part.substr(0, part.find(L'.'));
        if (!_wcsicmp(stem.c_str(), L"CON") || !_wcsicmp(stem.c_str(), L"PRN") || !_wcsicmp(stem.c_str(), L"AUX") ||
            !_wcsicmp(stem.c_str(), L"NUL") || !_wcsicmp(stem.c_str(), L"CONIN$") || !_wcsicmp(stem.c_str(), L"CONOUT$") ||
            (stem.size() == 4 && (!_wcsnicmp(stem.c_str(), L"COM", 3) || !_wcsnicmp(stem.c_str(), L"LPT", 3)) &&
            ((stem[3] >= L'0' && stem[3] <= L'9') || stem[3] == L'\u00b9' || stem[3] == L'\u00b2' || stem[3] == L'\u00b3'))) Refuse("UNSAFE_PATH");
        begin = i + 1;
    }
    const std::wstring root = value.substr(0, 3);
    if (GetDriveTypeW(root.c_str()) != DRIVE_FIXED) Refuse("UNSAFE_PATH");
    return value;
}
void Entries(const std::wstring& directory) {
    WIN32_FIND_DATAW data{};
    const HANDLE search = FindFirstFileW((directory + L"\\*").c_str(), &data);
    Check(search != INVALID_HANDLE_VALUE, "OPEN_FAILED");
    std::array<bool, 3> seen{}; bool invalid = false; DWORD finalError = ERROR_SUCCESS;
    do {
        if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L"..")) continue;
        size_t index = Names.size();
        for (size_t i = 0; i < Names.size(); ++i) if (!_wcsicmp(data.cFileName, Names[i])) { index = i; break; }
        if (index == Names.size() || seen[index] || (data.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) { invalid = true; break; }
        seen[index] = true;
    } while (FindNextFileW(search, &data));
    if (!invalid) finalError = GetLastError();
    FindClose(search);
    if (invalid || finalError != ERROR_NO_MORE_FILES || std::find(seen.begin(), seen.end(), false) != seen.end()) Refuse("UNEXPECTED_ENTRIES", static_cast<LONG>(finalError));
}
std::string Hex(const BYTE* bytes, size_t length) {
    constexpr char digits[] = "0123456789abcdef"; std::string result(length * 2, '0');
    for (size_t i = 0; i < length; ++i) { result[i * 2] = digits[bytes[i] >> 4]; result[i * 2 + 1] = digits[bytes[i] & 15]; }
    return result;
}
std::string RawHash(HANDLE file) {
    struct HashState {
        BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
        ~HashState() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
    } state;
    auto check = [](NTSTATUS status) { if (status < 0) Refuse("HASH_FAILED", status); };
    check(BCryptOpenAlgorithmProvider(&state.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
    check(BCryptCreateHash(state.algorithm, &state.hash, nullptr, 0, nullptr, 0, 0));
    LARGE_INTEGER zero{}; Check(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) != FALSE, "HASH_FAILED");
    std::array<BYTE, 65536> buffer{}; DWORD count = 0;
    for (;;) {
        Check(ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) != FALSE, "HASH_FAILED");
        if (!count) break;
        check(BCryptHashData(state.hash, buffer.data(), count, 0));
    }
    std::array<BYTE, 32> digest{}; check(BCryptFinishHash(state.hash, digest.data(), static_cast<ULONG>(digest.size()), 0));
    Check(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) != FALSE, "HASH_FAILED");
    return Hex(digest.data(), digest.size());
}
struct CatalogApi {
    using Acquire = BOOL(WINAPI*)(HCATADMIN*, const GUID*, PCWSTR, PCCERT_STRONG_SIGN_PARA, DWORD);
    using Calculate = BOOL(WINAPI*)(HCATADMIN, HANDLE, DWORD*, BYTE*, DWORD);
    using Provider = CRYPT_PROVIDER_DATA*(WINAPI*)(HANDLE);
    using Signer = CRYPT_PROVIDER_SGNR*(WINAPI*)(CRYPT_PROVIDER_DATA*, DWORD, BOOL, DWORD);
    HMODULE module = nullptr; HCATADMIN admin = nullptr; Acquire acquire = nullptr; Calculate calculate = nullptr;
    Provider provider = nullptr; Signer signer = nullptr;
    CatalogApi() {
        module = LoadLibraryExW(L"wintrust.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!module) Refuse("CATALOG_API_UNAVAILABLE", static_cast<LONG>(GetLastError()));
        const FARPROC a = GetProcAddress(module, "CryptCATAdminAcquireContext2"), c = GetProcAddress(module, "CryptCATAdminCalcHashFromFileHandle2");
        const FARPROC p = GetProcAddress(module, "WTHelperProvDataFromStateData"), s = GetProcAddress(module, "WTHelperGetProvSignerFromChain");
        static_assert(sizeof(a) == sizeof(acquire) && sizeof(c) == sizeof(calculate) && sizeof(p) == sizeof(provider) && sizeof(s) == sizeof(signer));
        std::memcpy(&acquire, &a, sizeof(a)); std::memcpy(&calculate, &c, sizeof(c));
        std::memcpy(&provider, &p, sizeof(p)); std::memcpy(&signer, &s, sizeof(s));
        if (!acquire || !calculate || !provider || !signer) { FreeLibrary(module); module = nullptr; Refuse("CATALOG_API_UNAVAILABLE"); }
        GUID action = DRIVER_ACTION_VERIFY;
        if (!acquire(&admin, &action, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) {
            const LONG error = static_cast<LONG>(GetLastError()); FreeLibrary(module); module = nullptr; Refuse("CATALOG_API_UNAVAILABLE", error);
        }
    }
    ~CatalogApi() { if (admin) CryptCATAdminReleaseContext(admin, 0); if (module) FreeLibrary(module); }
    CatalogApi(const CatalogApi&) = delete;
    CatalogApi& operator=(const CatalogApi&) = delete;
    void Verify(const std::wstring& catalogPath, const std::wstring& memberPath, HANDLE original) const {
        // SIP catalog digests can differ from raw artifact SHA256, especially for PE.
        LARGE_INTEGER zero{}; Check(SetFilePointerEx(original, zero, nullptr, FILE_BEGIN) != FALSE, "CATALOG_HASH_FAILED");
        DWORD length = 0;
        Check(calculate(admin, original, &length, nullptr, 0) != FALSE, "CATALOG_HASH_FAILED");
        if (length != 32) Refuse("CATALOG_HASH_FAILED");
        std::array<BYTE, 32> digest{};
        Check(SetFilePointerEx(original, zero, nullptr, FILE_BEGIN) != FALSE, "CATALOG_HASH_FAILED");
        Check(calculate(admin, original, &length, digest.data(), 0) != FALSE, "CATALOG_HASH_FAILED");
        if (length != digest.size()) Refuse("CATALOG_HASH_FAILED");
        const auto hex = Hex(digest.data(), digest.size()); std::wstring tag(hex.begin(), hex.end());
        for (auto& ch : tag) ch = static_cast<wchar_t>(towupper(ch));
        WINTRUST_CATALOG_INFO catalog{}; catalog.cbStruct = sizeof(catalog); catalog.pcwszCatalogFilePath = catalogPath.c_str();
        catalog.pcwszMemberTag = tag.c_str(); catalog.pcwszMemberFilePath = memberPath.c_str(); catalog.hMemberFile = original;
        catalog.pbCalculatedFileHash = digest.data(); catalog.cbCalculatedFileHash = length; catalog.hCatAdmin = admin;
        WINTRUST_DATA trust{}; trust.cbStruct = sizeof(trust); trust.dwUIChoice = WTD_UI_NONE;
        trust.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; trust.dwUnionChoice = WTD_CHOICE_CATALOG; trust.pCatalog = &catalog;
        trust.dwStateAction = WTD_STATEACTION_VERIFY;
        // Offline only. Missing revocation evidence refuses; never weaken policy.
        trust.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_USE_DEFAULT_OSVER_CHECK;
        GUID action = DRIVER_ACTION_VERIFY;
        const HWND noInteractiveWindow = reinterpret_cast<HWND>(INVALID_HANDLE_VALUE);
        const LONG status = WinVerifyTrust(noInteractiveWindow, &action, &trust);
        LONG signerStatus = TRUST_E_SUBJECT_NOT_TRUSTED;
        if (status == ERROR_SUCCESS) {
            const auto data = provider(trust.hWVTStateData);
            const auto verifiedSigner = data ? signer(data, 0, FALSE, 0) : nullptr;
            if (verifiedSigner && verifiedSigner->dwError) signerStatus = static_cast<LONG>(verifiedSigner->dwError);
            else if (verifiedSigner && verifiedSigner->pChainContext) {
                // Additional Microsoft production-root restriction; flags stay 0.
                // This policy alone is not driver verification and never replaces
                // DRIVER_ACTION_VERIFY. No test-root/application-root exception.
                // https://learn.microsoft.com/windows/win32/api/wincrypt/nf-wincrypt-certverifycertificatechainpolicy
                CERT_CHAIN_POLICY_PARA policy{}; policy.cbSize = sizeof(policy);
                CERT_CHAIN_POLICY_STATUS checked{}; checked.cbSize = sizeof(checked);
                if (CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_MICROSOFT_ROOT, verifiedSigner->pChainContext, &policy, &checked))
                    signerStatus = static_cast<LONG>(checked.dwError);
                else {
                    signerStatus = static_cast<LONG>(GetLastError());
                    if (signerStatus == ERROR_SUCCESS) signerStatus = TRUST_E_SUBJECT_NOT_TRUSTED;
                }
            }
        }
        trust.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(noInteractiveWindow, &action, &trust);
        Check(SetFilePointerEx(original, zero, nullptr, FILE_BEGIN) != FALSE, "CATALOG_HASH_FAILED");
        if (status != ERROR_SUCCESS) Refuse("CATALOG_TRUST_REFUSED", status);
        if (signerStatus != ERROR_SUCCESS) Refuse("CATALOG_SIGNER_REFUSED", signerStatus);
    }
};
} // namespace

struct VerifiedPackage::Impl {
    std::vector<Opened> directories;
    std::array<Opened, 3> files;
    std::array<std::string, 3> hashes;
    std::wstring directory;
    bool Unchanged() const {
        for (const auto& value : directories) if (!Same(value, true)) return false;
        for (size_t i = 0; i < files.size(); ++i) if (!Same(files[i]) || RawHash(files[i].handle) != hashes[i]) return false;
        Entries(directory); return true;
    }
};
VerifiedPackage::VerifiedPackage(std::unique_ptr<Impl> value) noexcept : impl_(std::move(value)) {}
VerifiedPackage::~VerifiedPackage() = default;
VerifiedPackage::VerifiedPackage(VerifiedPackage&&) noexcept = default;
VerifiedPackage& VerifiedPackage::operator=(VerifiedPackage&&) noexcept = default;
HANDLE VerifiedPackage::FileHandle(PackageFile file) const noexcept {
    const auto index = static_cast<size_t>(file);
    return impl_ && index < impl_->files.size() ? impl_->files[index].handle : INVALID_HANDLE_VALUE;
}
HANDLE VerifiedPackage::DirectoryHandle() const noexcept { return impl_ ? impl_->directories.back().handle : INVALID_HANDLE_VALUE; }
bool VerifiedPackage::Revalidate() const noexcept { try { return impl_ && impl_->Unchanged(); } catch (...) { return false; } }
Inspection::Inspection() {
    for (size_t i = 0; i < files.size(); ++i) { files[i].name = PublicNames[i]; files[i].sourcePinned = i < ApprovedHashes.size(); }
}

Inspection InspectPackage(const std::wstring& directory) {
    Inspection result;
    try {
        auto original = std::make_unique<VerifiedPackage::Impl>(); const auto admitted = AdmitPath(directory);
        // Lock every ancestor against rename/delete, not just the final directory.
        original->directories.push_back(Open(admitted.substr(0, 3), true, 0));
        const auto volume = BoundPath(original->directories.front().handle);
        // A drive letter is not stable authority. Reject SUBST roots and use the
        // original volume GUID for every later path lookup, including WinTrust.
        if (volume.rfind(L"\\\\?\\Volume{", 0) != 0 || volume.size() != 49 || volume.substr(47) != L"}\\") Refuse("UNSAFE_PATH");
        original->directory = volume + admitted.substr(3);
        for (size_t end = volume.size(); end <= original->directory.size(); ++end) {
            if (end != original->directory.size() && original->directory[end] != L'\\') continue;
            original->directories.push_back(Open(original->directory.substr(0, end), true, 0));
        }
        if (_wcsicmp(BoundPath(original->directories.back().handle).c_str(), original->directory.c_str())) Refuse("UNSAFE_PATH");
        for (size_t i = 0; i < Names.size(); ++i) {
            const auto path = original->directory + L"\\" + Names[i];
            original->files[i] = Open(path, false, Limits[i]);
            if (_wcsicmp(BoundPath(original->files[i].handle).c_str(), path.c_str())) Refuse("UNSAFE_PATH");
            result.files[i].opened = true; result.files[i].size = Size(original->files[i].identity);
        }
        Entries(original->directory);
        for (size_t i = 0; i < Names.size(); ++i) {
            original->hashes[i] = RawHash(original->files[i].handle); result.files[i].sha256 = original->hashes[i];
            if (i < ApprovedHashes.size()) result.files[i].hashMatched = original->hashes[i] == ApprovedHashes[i];
        }
        for (size_t i = 0; i < ApprovedHashes.size(); ++i) if (!result.files[i].hashMatched) Refuse("APPROVED_HASH_MISMATCH");
        CatalogApi catalog;
        for (size_t i = 0; i < ApprovedHashes.size(); ++i) {
            catalog.Verify(original->directory + L"\\" + Names[2], original->directory + L"\\" + Names[i], original->files[i].handle);
            result.files[i].catalogVerified = true;
        }
        if (!original->Unchanged()) Refuse("PACKAGE_CHANGED");
        result.package = std::unique_ptr<VerifiedPackage>(new VerifiedPackage(std::move(original)));
        result.reason = "VERIFIED";
    } catch (const Refusal& error) { result.reason = error.reason; result.nativeCode = error.code; }
    catch (...) { result.reason = "INTERNAL_FAILURE"; result.nativeCode = ERROR_UNHANDLED_EXCEPTION; }
    return result;
}
} // namespace reviewops::display::admission
