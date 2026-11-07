#pragma once

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include "PackageInstall.h"

namespace reviewops::display::softwaredevice {
// Supplied by trusted main/broker code after checking the original project and
// session. These identifiers alone are not an IPC authentication mechanism.
struct TrustedProjectBinding {
    GUID projectId{};
    GUID projectBirth{};
    GUID sessionId{};
};
struct DeviceObservation {
    const char* reason = "DEVICE_NOT_READY";
    LONG nativeCode = ERROR_SUCCESS;
    bool enumerated = false;
    bool driverConfirmed = false;
    bool interfacePresent = false;
    bool rebootRequired = false;
    bool installAttempted = false;
    // No control IOCTL or monitor operation is issued by this component.
    bool controlProtocolConfirmed = false;
};
struct CloseObservation {
    bool handleClosed = false;
    bool callbacksDrained = false;
    bool unplugRequested = false;
    bool removalConfirmed = false;
};
struct DeviceCreation;
class OwnedSoftwareDevice final {
public:
    ~OwnedSoftwareDevice();
    OwnedSoftwareDevice(OwnedSoftwareDevice&&) noexcept;
    OwnedSoftwareDevice& operator=(OwnedSoftwareDevice&&) = delete;
    OwnedSoftwareDevice(const OwnedSoftwareDevice&) = delete;
    OwnedSoftwareDevice& operator=(const OwnedSoftwareDevice&) = delete;
    TrustedProjectBinding Binding() const noexcept;
    std::wstring InstanceId() const;
    // Observes the exact callback-owned device and stored package without
    // installing. A proven foreign driver/class retires only this own handle.
    DeviceObservation CheckInstalledDevice() noexcept;
    // At most one actual DiInstallDevice attempt, on this exact devnode and one
    // selected driver from the original installed package. No global update.
    DeviceObservation InstallAndVerifyDriver() noexcept;
    // Refreshes the exact installed-device observation before returning its
    // internal path. A later control owner must still pin its Query reply.
    std::wstring InternalControlInterfacePath() const;
    // Retires this owner before waiting for other operations. SwDeviceClose has
    // no documented OS deadline; callback draining is not PnP-removal evidence.
    CloseObservation Close() noexcept;
private:
    struct Impl;
    explicit OwnedSoftwareDevice(std::unique_ptr<Impl>) noexcept;
    std::unique_ptr<Impl> impl_;
    friend DeviceCreation CreateOwnedSoftwareDevice(
        std::shared_ptr<const install::InstalledPackage>, const TrustedProjectBinding&);
};
struct DeviceCreation {
    DeviceObservation observation;
    std::unique_ptr<OwnedSoftwareDevice> owner;
};
// The shared capability must originate from ImportVerifiedPackage's unique_ptr.
// No caller-selected hardware ID, device path, parent, persistent lifetime or
// native-operation injection is accepted. Creating is an explicit native action.
DeviceCreation CreateOwnedSoftwareDevice(
    std::shared_ptr<const install::InstalledPackage> package,
    const TrustedProjectBinding& binding);
} // namespace reviewops::display::softwaredevice
