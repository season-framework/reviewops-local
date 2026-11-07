# Windows virtual display prototype

This is an unsigned, uninstalled UMDF 2 / IddCx component experiment for issue #9. It is separate from the ReviewOps application, NSIS installer, R56 packages and release version. Source code and a successful build do not establish that a driver installs, creates a usable monitor, survives power changes or is safe to distribute.

The implementation uses Microsoft's [IndirectDisplay sample](https://github.com/microsoft/Windows-driver-samples/tree/d49bb7d72f3651952b2b6e4ad28d14fe2247eb69/video/IndirectDisplay), pinned to `d49bb7d72f3651952b2b6e4ad28d14fe2247eb69`. The mode timing, D3D adapter initialization and swap-chain acknowledgment loop are adapted from `IddSampleDriver/Driver.cpp` (original SHA-256 `b6e9320291372a3f041e0bea716e15e7bc3d8df6359169e822d3eb3a281bdf3f`). Preserve the Microsoft notices and included [MS-PL.txt](MS-PL.txt), including the license conditions for source and binary distribution. No third-party driver, global monitor-count pipe, certificate import or external installer is included.

## File-owned control

The driver creates no monitor when its adapter starts. A successful file open creates an app-independent random file-owner ID. `WdfRequestGetFileObject` selects the actual original file object for every request; caller-provided process IDs, owner IDs, paths and commands are never accepted. The prototype admits at most 32 open file objects and eight monitors per adapter, with at most one monitor for each file.

`ControlProtocol.h` defines protocol version 1 and interface GUID `54af4a35-1a70-4d76-90ef-83c8aa237bb3`. The device hardware ID is `ROOT\REVIEWOPS_VIRTUAL_DISPLAY_PROTO`; a future explicitly admitted software-device creator can use compatible ID `ReviewOpsVirtualDisplayPrototype`. This experiment does not enumerate or install that device. Its INF restricts device access to SYSTEM and Administrators; a normal ReviewOps UI must later use a separately reviewed, narrowly authorized broker. The UI must not run permanently elevated.

The INF's `DDInstall.HW` registry settings supply both the protected SYSTEM/Administrators security descriptor and `DeviceCharacteristics=0x100` (`FILE_DEVICE_SECURE_OPEN`). Microsoft documents this [per-device installation setting](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/setting-device-object-registry-properties-during-installation) and [PnP propagation of the secure-open flag across the device stack](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/specifying-device-characteristics). The driver therefore uses these INF settings rather than the [KMDF-only `WdfDeviceInitSetCharacteristics` API](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfdevice/nf-wdfdevice-wdfdeviceinitsetcharacteristics). File creation additionally rejects relative names; each control still requires its original WDF file object and monitor identity. Installation-time ACL enforcement remains an unexecuted Windows qualification step.

All control calls use `METHOD_BUFFERED`. The full input is checked and copied before a reply can overwrite the shared system buffer. Inputs require exact size/version and zero reserved fields. Output length is exactly 96 bytes. Failure completes with its native NTSTATUS and zero reply bytes; no successful response is fabricated.

| IOCTL | Input | Behavior |
| --- | --- | --- |
| `Query` | `Header`, 8 bytes | Reports only this file's state and lease. No monitor mutation. |
| `Create` | `CreateRequest`, 24 bytes | Accepts only 1920×1080 or 3840×2160 at 60 Hz. Creates and reports one EDID-less monitor. The same mode on the same live lease returns that original lease; another mode is busy until explicit removal. |
| `Remove` | `RemoveRequest`, 32 bytes | Requires the current monitor ID on this exact file. A different file cannot remove it, even if it knows that ID. |

Replies contain a random device incarnation, file-owner ID and monitor ID. `IddCxMonitorArrival` supplies the OS adapter LUID and target ID; these are returned separately from the connector index. A companion must use the actual OS identity when mapping a monitor, rather than assuming that the connector index equals the OS target ID. No WDF handle or pointer crosses the wire.

`EvtFileCleanup` marks the original owner closing before retiring its monitor, including when I/O is still pending. Monitor departure and its swap-chain/worker cleanup run outside the ownership-map mutex. New requests cannot create a monitor behind that closing fence. `EvtFileClose` releases file metadata after WDF has drained the file's requests; monitor callbacks retain separate lease metadata. A successful `IddCxMonitorDeparture` destroys its monitor object, so it is never followed by `WdfObjectDelete` for that monitor. Never-arrived objects are deleted separately.

If departure fails, the driver reports `RemovalUnconfirmed`, retains that connector and native reference, and refuses create/remove replay. Closing the file does not promote that uncertainty to confirmed removal. Device teardown releases only this driver's retained references; the PnP framework owns adapter/monitor destruction. There is no global remove, reload, driver deletion or settings mutation command.

## Build boundary and Windows versions

The build project and toolchain pins are maintained separately. Compile `Driver.cpp` with C++17, UMDF 2.25, IddCx 1.4 and `IDDCX_MINIMUM_VERSION_REQUIRED=3`; link D3D11, DXGI, AVRT and BCrypt. Custom controls use `EvtIddCxDeviceIoControl`, since IddCx redirects control requests to its internal queue. No WPP generation or `Driver.tmh` is required.

Microsoft documents [IddCx 1.4 with minimum version 1.3](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/building-iddcx1.4-drivers) for Windows 10 version 1803 and later. The source uses initialization macros and base monitor/create/arrival/departure/swap-chain APIs; it does not use HDR, IddCx 1.10 or Windows 11-only monitor APIs. The INF declares separate x64 installation routes; Windows selects the closest applicable [OS build decoration](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/combining-platform-extensions-with-operating-system-versions).

| Declared OS | Models decoration | Reflector installation |
| --- | --- | --- |
| Windows 10 version 1803 and later | `NTamd64.10.0...17134` | `InstallWin10` retains `AddService=WUDFRd,0x000001fa,WUDFRDService` and the inbox `%12%\WUDFRd.sys`. The flags preserve an existing reflector service configuration. |
| Windows 11 (build 22000+) | `NTamd64.10.0...22000` | `InstallWin11` references `WUDFRD.inf` with `WUDFRD.NT`, `WUDFRD.NT.HW` and `WUDFRD.NT.Services`, following the pinned Microsoft IddSample. |

Microsoft's [reflector guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdf/adding-the-reflector) requires the legacy service declaration on Windows 10, where `WUDFRD.inf` is unavailable, and recommends the inbox INF on Windows 11. Both routes retain the same hardware IDs, device group, protected SYSTEM/Administrators security descriptor, secure-open flag and file-owned control behavior. The OS reflector binary is not included in this package.

Both routes load `ReviewOpsVirtualDisplay.dll` from `%13%`, the package's Driver Store directory. Microsoft supports [UMDF run from Driver Store](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdf/restricting-the-loading-location-of-umdf-drivers) from Windows 10 version 1803. `DriverCopy=13` and `ServiceBinary=%13%\ReviewOpsVirtualDisplay.dll` replace the shared `drivers\UMDF` destination. Source and destination both use the package root and preserve the DLL filename, satisfying the [Driver Store file-layout requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/develop/run-from-driver-store). These are declared installation paths, not tested Windows support or update qualification.

`DriverPackage.json` defines the prototype's fixed four-part INF version and UTC date. `Build.ps1` supplies them to StampInf, refuses `PRIVATE_DRIVER_PACKAGE` overrides and checks the generated INF before proceeding. This identity is independent of ReviewOps release versions and is not incremented for each source commit. Earlier run 42336979866 retained its original automatically stamped `4.8.14.621` artifact; it was never installed or published as a signed driver package.

The native build retains separate InfVerif `/u /v /info /osver` logs for x64 builds 17134, 19045, 22000 and 26100. These checks evaluate static INF applicability. They do not establish installation, foreign-OS inbox `Include/Needs` availability, package signing or runtime compatibility; target-product IAS validation and actual Windows installation remain separate gates.

`Inspect-InfSelection.ps1` separately asks Windows SetupAPI to select the actual Models and DDInstall sections for those four alternate-platform profiles, using the V3 structure's build number. It records both hardware IDs and native errors, closes its INF handles and refuses unsupported V3 calls without substituting a text-parser result. This is a read-only INF-file operation, not device creation or installation on four operating systems.

Inf2Cat then validates a fresh directory containing only this generated INF and DLL for Windows 10 1803/22H2 and Windows 11 21H2/24H2 x64, and generates an unsigned catalog. The build records all three package files and refuses a signed catalog. Catalog creation checks package layout and signability prerequisites; it does not sign, stage or install a driver, import a certificate or change boot/security settings.

## Remaining verification

No driver, broker or display operation has been executed as part of authoring this source. No certificate was created/imported, no test mode or signature setting was changed, and no driver was installed. Each changed installation route still requires its targeted Windows INF validation before installation or signing.

Before any installation proposal, review the resulting INF/catalog/DLL identities and supported signing route. Microsoft's [signing guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings) distinguishes HLK/WHCP distribution from attestation testing; an application signature is not a verified driver-package signature. Separate elevated installation/control from user-session capture/input.

Actual Windows 10/11 x64 qualification still needs two independent file owners, wrong-owner remove rejection, same-handle retries, file-close/process-crash races, monitor arrival/removal observations, mode changes, GPU reset, sleep/resume, RDP changes and PnP teardown. The current adapter initialization and sample frame-drain worker are not qualified for those recovery paths. Window migration before removal, DPI/negative-coordinate mapping, capture and screenshot provenance, keyboard/input guards and stuck-key release are not implemented. `SendInput` shares user-session input/focus and has integrity-level limits; no private input desktop or elevated/UAC/lock-screen access is claimed. Existing ReviewOps capabilities remain unchanged.
