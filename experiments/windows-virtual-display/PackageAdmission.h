#pragma once

#include <windows.h>
#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace reviewops::display::admission {
inline constexpr char ApprovedSource[] = "884e87504c5b56133e46bbeb65cae6d441baa1ba";
enum class PackageFile : size_t { Inf, Dll, Catalog };
struct FileObservation {
    const char* name = "";
    bool opened = false;
    uint64_t size = 0;
    std::string sha256;
    bool sourcePinned = false;
    bool hashMatched = false;
    bool catalogVerified = false;
};
struct Inspection;
class VerifiedPackage final {
public:
    ~VerifiedPackage();
    VerifiedPackage(VerifiedPackage&&) noexcept;
    VerifiedPackage& operator=(VerifiedPackage&&) noexcept;
    VerifiedPackage(const VerifiedPackage&) = delete;
    VerifiedPackage& operator=(const VerifiedPackage&) = delete;
    // Borrowed original read handles, valid only while this object is alive.
    HANDLE FileHandle(PackageFile file) const noexcept;
    HANDLE DirectoryHandle() const noexcept;
    // Rechecks the retained originals. This does not authorize a path-based install.
    bool Revalidate() const noexcept;
private:
    struct Impl;
    explicit VerifiedPackage(std::unique_ptr<Impl>) noexcept;
    std::unique_ptr<Impl> impl_;
    friend Inspection InspectPackage(const std::wstring& directory);
};
struct Inspection {
    Inspection();
    const char* reason = "INTERNAL_FAILURE";
    LONG nativeCode = ERROR_SUCCESS;
    std::array<FileObservation, 3> files{};
    std::unique_ptr<VerifiedPackage> package;
};
// No caller-supplied manifest, trust store mutation, catalog registration or install.
// A future installer must copy these handles into new protected staging, recheck
// that copy and its signature, and only then use path-based SetupAPI operations.
Inspection InspectPackage(const std::wstring& directory);
} // namespace reviewops::display::admission
