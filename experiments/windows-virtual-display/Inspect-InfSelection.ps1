# Read-only SetupAPI section selection; this does not install or open a device.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InfPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    schema = 1
    scope = 'Read-only SetupAPI alternate-platform INF section selection'
    status = 'running'
    driverInstalled = $false
    driverExecuted = $false
    deviceOpened = $false
    startedAtUTC = [DateTime]::UtcNow.ToString('o')
    profiles = @()
}
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') {
        throw 'Native x64 PowerShell 7 on Windows is required.'
    }
    $inf = (Resolve-Path -LiteralPath $InfPath -ErrorAction Stop).ProviderPath
    if ([IO.Path]::GetExtension($inf) -ine '.inf') { throw 'An INF file is required.' }
    $report['infSHA256'] = (Get-FileHash -LiteralPath $inf -Algorithm SHA256).Hash.ToLowerInvariant()
    # Layout and declarations follow the official SetupAPI.h (V3, not V2):
    # https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/SetupAPI.h
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace ReviewOpsInfSelection {
    public sealed class ModelRow {
        public string Description { get; set; }
        public string InstallSection { get; set; }
        public string ActualInstallSection { get; set; }
        public int ActualInstallLineCount { get; set; }
        public List<string> HardwareIds { get; set; } = new List<string>();
    }
    public sealed class Profile {
        public uint MajorVersion { get; set; } = 10;
        public uint MinorVersion { get; set; } = 0;
        public uint BuildNumber { get; set; }
        public string Architecture { get; set; } = "AMD64";
        public string ProductType { get; set; } = "Workstation";
        public uint AlternatePlatformStructureBytes { get; set; }
        public string ModelsSection { get; set; }
        public List<ModelRow> Models { get; set; } = new List<ModelRow>();
        public string Status { get; set; } = "failed";
        public string Error { get; set; }
        public uint? Win32ErrorCode { get; set; }
        public string Win32ErrorHex { get; set; }
    }
    public static class Inspector {
        [StructLayout(LayoutKind.Sequential)]
        struct InfContext { public IntPtr Inf, CurrentInf; public uint Section, Line; }
        [StructLayout(LayoutKind.Sequential)]
        struct AlternatePlatformV3 {
            public uint Size, Platform, MajorVersion, MinorVersion;
            public ushort ProcessorArchitecture, Flags;
            public uint FirstValidatedMajorVersion, FirstValidatedMinorVersion;
            public byte ProductType;
            public ushort SuiteMask;
            public uint BuildNumber;
        }
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern IntPtr SetupOpenInfFileW(string file, string infClass, uint style, out uint errorLine);
        [DllImport("setupapi.dll", ExactSpelling = true)]
        static extern void SetupCloseInfFile(IntPtr inf);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetupFindFirstLineW(IntPtr inf, string section, string key, out InfContext context);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetupGetLineByIndexW(IntPtr inf, string section, uint index, out InfContext context);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern int SetupGetLineCountW(IntPtr inf, string section);
        [DllImport("setupapi.dll", ExactSpelling = true)]
        static extern uint SetupGetFieldCount(ref InfContext context);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetupGetStringFieldW(ref InfContext context, uint index, StringBuilder buffer, uint length, out uint required);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetupDiGetActualModelsSectionW(ref InfContext context, ref AlternatePlatformV3 platform, StringBuilder section, uint length, out uint required, IntPtr reserved);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetupDiGetActualSectionToInstallExW(IntPtr inf, string section, ref AlternatePlatformV3 platform, StringBuilder actual, uint length, out uint required, IntPtr extension, IntPtr reserved);
        sealed class NativeFailure : Win32Exception {
            public readonly uint OriginalCode;
            public NativeFailure(string api, int code) : base(code, api + " failed: " + new Win32Exception(code).Message) { OriginalCode = unchecked((uint)code); }
        }
        static NativeFailure LastError(string api) { return new NativeFailure(api, Marshal.GetLastWin32Error()); }
        static string Field(ref InfContext context, uint index) {
            var value = new StringBuilder(4096);
            uint required;
            if (!SetupGetStringFieldW(ref context, index, value, (uint)value.Capacity, out required)) throw LastError("SetupGetStringFieldW");
            if (required == 0 || required > value.Capacity) throw new InvalidOperationException("Invalid INF field length.");
            return value.ToString();
        }
        public static Profile Inspect(string file, uint build) {
            var result = new Profile { BuildNumber = build };
            IntPtr inf = new IntPtr(-1);
            try {
                uint size = (uint)Marshal.SizeOf<AlternatePlatformV3>();
                result.AlternatePlatformStructureBytes = size;
                if (IntPtr.Size != 8 || Marshal.SizeOf<InfContext>() != 24 || size != 36 || Marshal.OffsetOf<AlternatePlatformV3>("BuildNumber").ToInt32() != 32)
                    throw new InvalidOperationException("Unexpected x64 SetupAPI structure layout.");
                var platform = new AlternatePlatformV3 { Size = size, Platform = 2, MajorVersion = 10, MinorVersion = 0, ProcessorArchitecture = 9, ProductType = 1, BuildNumber = build };
                uint errorLine;
                inf = SetupOpenInfFileW(file, null, 0x2U | 0x40U, out errorLine);
                if (inf == new IntPtr(-1) || inf == IntPtr.Zero) throw LastError("SetupOpenInfFileW (line " + errorLine + ")");
                int manufacturers = SetupGetLineCountW(inf, "Manufacturer");
                if (manufacturers < 0) throw LastError("SetupGetLineCountW(Manufacturer)");
                if (manufacturers != 1) throw new InvalidOperationException("Exactly one Manufacturer entry is required.");
                InfContext manufacturer;
                if (!SetupFindFirstLineW(inf, "Manufacturer", null, out manufacturer)) throw LastError("SetupFindFirstLineW(Manufacturer)");
                var models = new StringBuilder(256);
                uint required;
                if (!SetupDiGetActualModelsSectionW(ref manufacturer, ref platform, models, (uint)models.Capacity, out required, IntPtr.Zero))
                    throw LastError("SetupDiGetActualModelsSectionW");
                if (required == 0 || required > models.Capacity) throw new InvalidOperationException("Invalid Models section length.");
                result.ModelsSection = models.ToString();
                int count = SetupGetLineCountW(inf, result.ModelsSection);
                if (count < 0) throw LastError("SetupGetLineCountW(Models)");
                if (count == 0 || count > 16) throw new InvalidOperationException("Unexpected Models line count.");
                for (uint index = 0; index < count; ++index) {
                    InfContext line;
                    if (!SetupGetLineByIndexW(inf, result.ModelsSection, index, out line)) throw LastError("SetupGetLineByIndexW");
                    uint fields = SetupGetFieldCount(ref line);
                    if (fields < 2 || fields > 16) throw new InvalidOperationException("Unexpected Models field count.");
                    var row = new ModelRow { Description = Field(ref line, 0), InstallSection = Field(ref line, 1) };
                    result.Models.Add(row);
                    for (uint field = 2; field <= fields; ++field) row.HardwareIds.Add(Field(ref line, field));
                    var actual = new StringBuilder(256);
                    if (!SetupDiGetActualSectionToInstallExW(inf, row.InstallSection, ref platform, actual, (uint)actual.Capacity, out required, IntPtr.Zero, IntPtr.Zero))
                        throw LastError("SetupDiGetActualSectionToInstallExW");
                    if (required == 0 || required > actual.Capacity) throw new InvalidOperationException("Invalid DDInstall section length.");
                    row.ActualInstallSection = actual.ToString();
                    row.ActualInstallLineCount = SetupGetLineCountW(inf, row.ActualInstallSection);
                    if (row.ActualInstallLineCount < 0) throw LastError("SetupGetLineCountW(DDInstall)");
                    if (row.ActualInstallLineCount == 0) throw new InvalidOperationException("The selected DDInstall section is empty.");
                }
                result.Status = "observed";
            } catch (NativeFailure error) {
                result.Error = error.Message;
                result.Win32ErrorCode = error.OriginalCode;
                result.Win32ErrorHex = "0x" + error.OriginalCode.ToString("X8");
            } catch (Exception error) { result.Error = error.Message; }
            finally { if (inf != new IntPtr(-1) && inf != IntPtr.Zero) SetupCloseInfFile(inf); }
            return result;
        }
    }
}
'@
    foreach ($build in @(17134, 19045, 22000, 26100)) {
        $profile = [ReviewOpsInfSelection.Inspector]::Inspect($inf, $build)
        $expectedModels = if ($build -lt 22000) { 'Models.NTamd64.10.0...17134' } else { 'Models.NTamd64.10.0...22000' }
        $expectedInstall = if ($build -lt 22000) { 'InstallWin10' } else { 'InstallWin11' }
        $report['profiles'] += $profile
        if ($profile.Status -ne 'observed') { throw "SetupAPI selection failed for build $build; see the original Win32 error in the report." }
        $ids = @($profile.Models | ForEach-Object { $_.HardwareIds })
        if ($profile.ModelsSection -ine $expectedModels -or $profile.Models.Count -ne 2 -or $ids.Count -ne 2 -or
            $ids -inotcontains 'ReviewOpsVirtualDisplayPrototype' -or $ids -inotcontains 'ROOT\REVIEWOPS_VIRTUAL_DISPLAY_PROTO') {
            $profile.Status = 'unexpected-selection'
            throw "SetupAPI returned unexpected Models or hardware IDs for build $build."
        }
        foreach ($row in $profile.Models) {
            if ($row.InstallSection -ine $expectedInstall -or $row.ActualInstallSection -ine ($expectedInstall + '.NT')) {
                $profile.Status = 'unexpected-selection'
                throw "SetupAPI returned an unexpected DDInstall section for build $build."
            }
        }
        $profile.Status = 'passed'
    }
    $report['status'] = 'passed-read-only-section-selection'
} catch {
    $report['status'] = 'failed'
    $report['error'] = $_.Exception.Message
    throw
} finally {
    $report['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $output = [IO.Path]::GetFullPath($OutputPath)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8
}
