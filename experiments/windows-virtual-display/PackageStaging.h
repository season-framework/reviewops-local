#pragma once

#include "PackageAdmission.h"

namespace reviewops::display::staging {
struct CleanupResult {
    bool complete = false;
    const char* reason = "CLEANUP_UNCONFIRMED";
    LONG nativeCode = ERROR_SUCCESS;
};
struct StagingResult;
class StagedPackage final {
public:
    ~StagedPackage();
    StagedPackage(StagedPackage&&) noexcept;
    StagedPackage& operator=(StagedPackage&&) = delete;
    StagedPackage(const StagedPackage&) = delete;
    StagedPackage& operator=(const StagedPackage&) = delete;
    bool Ready() const noexcept;
    const admission::VerifiedPackage* Verified() const noexcept;
    // Private in-process path, not a serializable admission ticket. Revalidate
    // immediately before any future path-based SetupAPI call while retaining us.
    std::wstring InternalInfPath() const;
    bool Revalidate() const noexcept;
    // Retires admission before deleting only the original owned files/directory.
    // Explicitly inspect this result; the destructor only attempts scoped cleanup.
    CleanupResult Cleanup() noexcept;
private:
    struct Impl;
    explicit StagedPackage(std::unique_ptr<Impl>) noexcept;
    std::unique_ptr<Impl> impl_;
    friend StagingResult StageVerifiedPackage(admission::VerifiedPackage&& source);
};
struct StagingResult {
    bool ready = false;
    const char* reason = "STAGING_FAILED";
    LONG nativeCode = ERROR_SUCCESS;
    bool cleanupComplete = true;
    // On refused staging, a non-ready owner preserves unresolved cleanup scope.
    // Only Ready()/Verified(), never this pointer alone, conveys staged admission.
    std::unique_ptr<StagedPackage> owner;
};
// Accepts only the actual move-only admission capability. No caller-selected
// destination, hashes, manifest, policy override, elevation prompt or installer.
StagingResult StageVerifiedPackage(admission::VerifiedPackage&& source);
} // namespace reviewops::display::staging
