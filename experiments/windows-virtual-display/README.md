# Windows virtual display prototype

This is an unsigned, uninstalled UMDF 2 / IddCx component experiment for issue #9. It is separate from the ReviewOps application, NSIS installer, R56 packages and release version. Source code and a successful build do not establish that a driver installs, creates a usable monitor, survives power changes or is safe to distribute.

The implementation uses Microsoft's [IndirectDisplay sample](https://github.com/microsoft/Windows-driver-samples/tree/d49bb7d72f3651952b2b6e4ad28d14fe2247eb69/video/IndirectDisplay), pinned to `d49bb7d72f3651952b2b6e4ad28d14fe2247eb69`. The mode timing, D3D adapter initialization and swap-chain acknowledgment loop are adapted from `IddSampleDriver/Driver.cpp` (original SHA-256 `b6e9320291372a3f041e0bea716e15e7bc3d8df6359169e822d3eb3a281bdf3f`). Preserve the Microsoft notices and included [MS-PL.txt](MS-PL.txt), including the license conditions for source and binary distribution. No third-party driver, global monitor-count pipe, certificate import or external installer is included.

## File-owned control

The driver creates no monitor when its adapter starts. A successful file open creates an app-independent random file-owner ID. `WdfRequestGetFileObject` selects the actual original file object for every request; caller-provided process IDs, owner IDs, paths and commands are never accepted. The prototype admits at most 32 open file objects and eight monitors per adapter, with at most one monitor for each file.

`ControlProtocol.h` defines protocol version 1 and interface GUID `54af4a35-1a70-4d76-90ef-83c8aa237bb3`. The device hardware ID is `ROOT\REVIEWOPS_VIRTUAL_DISPLAY_PROTO`; a future explicitly admitted software-device creator can use compatible ID `ReviewOpsVirtualDisplayPrototype`. This experiment does not enumerate or install that device. Its INF restricts device access to SYSTEM and Administrators; a normal ReviewOps UI must later use a separately reviewed, narrowly authorized broker. The UI must not run permanently elevated.

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

Microsoft documents [IddCx 1.4 with minimum version 1.3](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/building-iddcx1.4-drivers) for Windows 10 version 1803 and later. The source uses initialization macros and base monitor/create/arrival/departure/swap-chain APIs; it does not use HDR, IddCx 1.10 or Windows 11-only monitor APIs. The INF's x64 OS decoration starts at build 17134 and uses the Windows 10-compatible WUDFRd service declaration, rather than copying the current sample's build-22000-only `WUDFRD.inf` sections. These are declared targets, not tested Windows support.

## Remaining verification

No driver, broker or display operation has been executed as part of authoring this source. No certificate was created/imported, no test mode or signature setting was changed, and no driver was installed. A Windows compiler/INF check is the next component gate, without installation or signing.

Before any installation proposal, review the resulting INF/catalog/DLL identities and supported signing route. Microsoft's [signing guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings) distinguishes HLK/WHCP distribution from attestation testing; an application signature is not a verified driver-package signature. Separate elevated installation/control from user-session capture/input.

Actual Windows 10/11 x64 qualification still needs two independent file owners, wrong-owner remove rejection, same-handle retries, file-close/process-crash races, monitor arrival/removal observations, mode changes, GPU reset, sleep/resume, RDP changes and PnP teardown. The current adapter initialization and sample frame-drain worker are not qualified for those recovery paths. Window migration before removal, DPI/negative-coordinate mapping, capture and screenshot provenance, keyboard/input guards and stuck-key release are not implemented. `SendInput` shares user-session input/focus and has integrity-level limits; no private input desktop or elevated/UAC/lock-screen access is claimed. Existing ReviewOps capabilities remain unchanged.
