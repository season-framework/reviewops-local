#pragma once

#include "OwnedSoftwareDevice.h"
#include "ControlProtocol.h"

namespace reviewops::display::control {
enum class Operation { Open, Status, Create1080, Create4k, Remove };
struct ControlObservation {
    Operation operation = Operation::Open;
    const char* reason = "CONTROL_NOT_READY";
    DWORD win32Error = ERROR_SUCCESS;
    DWORD completionWin32Error = ERROR_IO_INCOMPLETE;
    bool cancelRequested = false;
    DWORD cancelWin32Error = ERROR_SUCCESS;
    bool ioAttempted = false;
    bool ioCompleted = false;
    bool mutationAttempted = false;
    bool completionUnconfirmed = false;
    bool protocolConfirmed = false;
    bool mutationsBlocked = true;
    bool retired = false;
    bool hasReply = false;
    // A bounded observation, never a serializable control capability.
    Reply reply{};
};
struct CloseObservation {
    bool fileHandleClosed = false;
    bool ioCompletionConfirmed = false;
    bool pendingQuarantined = false;
    bool stickyDeviceRetirement = false;
    bool monitorRemovalConfirmed = false;
    bool softwareDeviceClosed = false;
};
struct ControlOpening;
class OwnedDisplayControl final {
public:
    ~OwnedDisplayControl();
    OwnedDisplayControl(OwnedDisplayControl&&) noexcept;
    OwnedDisplayControl& operator=(OwnedDisplayControl&&) = delete;
    OwnedDisplayControl(const OwnedDisplayControl&) = delete;
    OwnedDisplayControl& operator=(const OwnedDisplayControl&) = delete;
    softwaredevice::TrustedProjectBinding Binding() const noexcept;
    ControlObservation Status() noexcept;
    ControlObservation Create1080() noexcept;
    ControlObservation Create4k() noexcept;
    ControlObservation Remove() noexcept;
    // Invalidates this owner first. Only the exact outstanding IRP may be drained;
    // no new IOCTL, remove replay or software-device close is performed here.
    // Native CloseHandle/underlying driver cleanup has no OS deadline guarantee.
    CloseObservation Close() noexcept;
private:
    struct Impl;
    explicit OwnedDisplayControl(std::unique_ptr<Impl>) noexcept;
    ControlObservation Perform(Operation) noexcept;
    std::unique_ptr<Impl> impl_;
    friend ControlOpening OpenOwnedDisplayControl(
        std::shared_ptr<softwaredevice::OwnedSoftwareDevice>,
        const softwaredevice::TrustedProjectBinding&);
};
struct ControlOpening {
    ControlObservation observation;
    std::unique_ptr<OwnedDisplayControl> owner;
};
// Device must originate from the actual package-gated software-device factory.
// Trusted main must validate current project birth/session before calling and
// retire this control before closing/moving the software device or replacing its
// project. Binding GUIDs and shared_ptr ownership alone do not authenticate IPC.
// No caller-selected path, monitor GUID, IOCTL or transport injection is accepted.
ControlOpening OpenOwnedDisplayControl(
    std::shared_ptr<softwaredevice::OwnedSoftwareDevice> device,
    const softwaredevice::TrustedProjectBinding& binding);
} // namespace reviewops::display::control
