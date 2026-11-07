# Prototype control client

This source is an experimental Windows console client. Compilation does not prove
installation, standard-user access, display lifecycle, signing or product UI
acceptance. It contains no installer or elevation request.

The native build also checks read-only enumeration on a fresh host without this
driver, refusal of an unlisted instance and refusal of unsupported arguments.
These checks do not open a device, send IOCTLs or qualify monitor control.

`ReviewOpsVirtualDisplayClient.exe --list` enumerates only the protocol's device
interface class with SetupDi. JSON lists exact device instance IDs and interface
active flags. It does not open the device, query a driver, create a monitor or
claim that control access is available. No device interface path is printed.

`ReviewOpsVirtualDisplayClient.exe --control "<exact instanceId from --list>"`
re-enumerates that class, requires one active exact instance match, and opens its
enumerated interface once. It retains that original, non-inheritable file handle
until EOF, `quit`, a fatal refusal or the 64-command limit. No caller-supplied
device path is accepted. Its initial query is read-only and pins the actual
device/file-owner GUIDs. An unexpected initial monitor is not adopted.

Send one ASCII command per newline on stdin:

| Command | Effect |
| --- | --- |
| `status` | Query only this original file's lease. |
| `create1080` | Explicitly request one 1920×1080, 60 Hz monitor. |
| `create4k` | Explicitly request one 3840×2160, 60 Hz monitor. |
| `remove` | Remove only the GUID returned by this client's successful create. |
| `quit` | Close this file; no separate remove command is sent. |

Remove the existing owned monitor explicitly before requesting a different mode.
Commands are limited to 128 bytes; partial commands at EOF are refused. Waiting
for stdin does not create or renew a monitor. Each IOCTL waits at most five
seconds, followed by at most two seconds to observe exact cancellation completion.
If completion is still unknown, the request's heap buffers, `OVERLAPPED` and event
remain alive until process exit. No more commands run. A failed I/O blocks further
mutations, while completed failures can still be followed by a `status` query;
there is no automatic replay or handle replacement.

Every reply must have the exact shared-header size/version, zero reserved field,
valid state/mode and unchanged device/file-owner identities. The current reply
is 96 bytes. JSON distinguishes the driver connector index from the actual
IddCx arrival receipt's adapter LUID and OS target ID. These are file-scoped
observations, not a global display count or an independent OS lifecycle check.
Handle closure, cancellation and process exit do not certify physical monitor
removal. A removal-unconfirmed state blocks new create/remove commands.

The SetupDi detail and asynchronous I/O lifetimes follow Microsoft's
[interface enumeration](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetdeviceinterfacedetailw)
and [cancellation guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/canceling-pending-i-o-operations).
