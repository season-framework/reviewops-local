#pragma once

#include "PackageStaging.h"

namespace reviewops::display::install {
enum class ImportDisposition { NotAttempted, Imported, AlreadyPresent, PublishedUnqualified, Uncertain };
struct ImportResult;
class InstalledPackage final {
public:
    ~InstalledPackage();
    InstalledPackage(InstalledPackage&&) noexcept;
    InstalledPackage& operator=(InstalledPackage&&) = delete;
    InstalledPackage(const InstalledPackage&) = delete;
    InstalledPackage& operator=(const InstalledPackage&) = delete;
    bool Revalidate() const noexcept;
    std::wstring PublishedInfName() const;
    std::wstring InternalDriverStoreInfPath() const;
private:
    struct Impl;
    explicit InstalledPackage(std::unique_ptr<Impl>) noexcept;
    std::unique_ptr<Impl> impl_;
    friend ImportResult ImportVerifiedPackage(staging::StagedPackage&& source);
};
struct ImportResult {
    bool ready = false;
    const char* reason = "IMPORT_REFUSED";
    LONG nativeCode = ERROR_SUCCESS;
    bool importAttempted = false;
    bool apiSucceeded = false;
    DWORD setupError = ERROR_SUCCESS;
    ImportDisposition disposition = ImportDisposition::NotAttempted;
    // Diagnostic only; an OEM name is not an import/device admission capability.
    std::wstring publishedInfName;
    std::unique_ptr<InstalledPackage> package;
    // Returned on failure. Import never explicitly cleans its staging source.
    std::unique_ptr<staging::StagedPackage> staging;
};
// One actual SetupCopyOEMInf call from this retained capability only. No caller
// paths/manifests, automatic retry, package deletion, device installation or UI.
ImportResult ImportVerifiedPackage(staging::StagedPackage&& source);
} // namespace reviewops::display::install
