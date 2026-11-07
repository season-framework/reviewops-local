#Requires -Version 7.0
# Negative native admission checks only. No driver or certificate is installed.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InspectorPath,
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required.' }
$approvedSource = '884e87504c5b56133e46bbeb65cae6d441baa1ba'
$names = @('ReviewOpsVirtualDisplay.inf', 'ReviewOpsVirtualDisplay.dll', 'reviewopsvirtualdisplay.cat')
$approvedHashes = @(
    '68cbc49405e2165ad6053f76727e25de540413c9feebc42063bdb1e3ae30c863',
    'f8d77b15537470fa33e8b32633c8b3a600e4a9a1b85a00a4a1ea1916619c2eee'
)
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert-OrdinaryPath([string]$Path, [bool]$Directory) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:\\' -or $full.StartsWith('\\')) { throw 'An ordinary local absolute path is required.' }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer -ne $Directory) { throw 'Unexpected path type.' }
    $cursor = $item
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestors are not admitted.' }
        $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
    }
    return $item.FullName.TrimEnd('\')
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$inspector = Assert-OrdinaryPath $InspectorPath $false
$original = Assert-OrdinaryPath $PackagePath $true
$out = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if ([IO.Path]::GetExtension($inspector) -ne '.exe' -or $original.Length -gt 220) { throw 'Unsupported inspector or original package path.' }
if (Test-Path -LiteralPath $out) { throw 'OutputDirectory must be a new owned directory.' }
$parent = Assert-OrdinaryPath ([IO.Path]::GetDirectoryName($out)) $true
if ($out -eq $original -or $out.StartsWith($original + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output cannot be inside the original package.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$out = Assert-OrdinaryPath $out $true
$fixtures = Join-Path $out 'fixtures'
[IO.Directory]::CreateDirectory($fixtures) | Out-Null
$reportPath = Join-Path $out 'package-admission-results.json'
$report = [ordered]@{
    version = 1
    scope = 'Native negative package admission only; no installation or display execution'
    status = 'running'
    approvedSource = $approvedSource
    startedAtUTC = [DateTime]::UtcNow.ToString('o')
    inspector = [ordered]@{ path = $inspector; sha256 = (Hash $inspector) }
    originalPackage = [ordered]@{ path = $original; files = @(); unchanged = $false }
    driverInstalled = $false
    driverStarted = $false
    certificatesImported = $false
    catalogRegistered = $false
    displayChanged = $false
    positiveSignedDriverAdmissionProven = $false
    positiveSignedDriverAdmissionStatus = 'not-executed'
    counts = [ordered]@{ passed = 0; failed = 0; skipped = 0; total = 0 }
    cases = @()
    optionalCatalogSelection = $null
}
function Save-Report {
    $temporary = Join-Path $out 'package-admission-results.next.json'
    [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine, $utf8)
    [IO.File]::Move($temporary, $reportPath, $true)
}
function Snapshot-Original {
    $entries = @(Get-ChildItem -LiteralPath $original -Force)
    if ($entries.Count -ne 3 -or @($entries | Where-Object { $_.PSIsContainer -or $_.Name -notin $names }).Count) { throw 'Original package must have exactly the three expected files.' }
    return @($names | ForEach-Object {
        $path = Assert-OrdinaryPath (Join-Path $original $_) $false
        $item = Get-Item -LiteralPath $path -Force
        [ordered]@{ name = $_; bytes = $item.Length; sha256 = (Hash $path); lastWriteUTC = $item.LastWriteTimeUtc.ToString('o') }
    })
}
function New-PackageCopy([string]$Name) {
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid owned fixture name.' }
    $destination = Join-Path $fixtures $Name
    if ($destination.Length -gt 220 -or (Test-Path -LiteralPath $destination)) { throw 'Fixture path is unavailable.' }
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($name in $names) { [IO.File]::Copy((Join-Path $original $name), (Join-Path $destination $name), $false) }
    return $destination
}
function Invoke-OwnedProcess([string]$Name, [string]$Program, [string[]]$Arguments, [hashtable]$EnvironmentValues = @{}) {
    $start = [Diagnostics.ProcessStartInfo]::new($Program)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($key in $EnvironmentValues.Keys) { $start.Environment[$key] = $EnvironmentValues[$key] }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $row = [ordered]@{ executable = $Program; arguments = $Arguments; started = $false; pid = $null; startTimeUTC = $null; timeoutMs = 10000; exitCode = $null; exitConfirmed = $false; terminationRequested = $false; stdout = ''; stderr = ''; elapsedMs = 0 }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { throw 'Owned process failed to start.' }
        $row.started = $true
        $row.pid = $process.Id
        $row.startTimeUTC = $process.StartTime.ToUniversalTime().ToString('o')
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit([int][Math]::Max(0, 10000 - $watch.ElapsedMilliseconds))) {
            $row.terminationRequested = $true
            $process.Kill() # Only the Process instance started immediately above.
            $row.exitConfirmed = $process.WaitForExit([int][Math]::Max(0, [Math]::Min(2000, 12000 - $watch.ElapsedMilliseconds)))
        } else { $row.exitConfirmed = $true }
        if ($row.exitConfirmed) { $row.exitCode = $process.ExitCode }
        $streams = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr))
        if (-not $streams.Wait([int][Math]::Max(0, [Math]::Min(2000, 12000 - $watch.ElapsedMilliseconds)))) { throw 'Owned stdout/stderr completion was not confirmed.' }
        $row.stdout = $stdout.GetAwaiter().GetResult()
        $row.stderr = $stderr.GetAwaiter().GetResult()
        if ($row.stdout.Length -gt 262144 -or $row.stderr.Length -gt 262144) {
            $row.stdout = $row.stdout.Substring(0, [Math]::Min(262144, $row.stdout.Length))
            $row.stderr = $row.stderr.Substring(0, [Math]::Min(262144, $row.stderr.Length))
            $row['outputTruncated'] = $true
            throw 'Owned process output exceeded the receipt limit.'
        }
    } catch {
        $row['harnessError'] = 'OWNED_PROCESS_NOT_VERIFIED'
        if ($row.started -and -not $row.exitConfirmed) {
            try {
                if (-not $process.HasExited -and -not $row.terminationRequested) { $row.terminationRequested = $true; $process.Kill() }
                $row.exitConfirmed = $process.WaitForExit([int][Math]::Max(0, [Math]::Min(2000, 12000 - $watch.ElapsedMilliseconds)))
                if ($row.exitConfirmed) { $row.exitCode = $process.ExitCode }
            } catch { $row['cleanupUnconfirmed'] = $true }
        }
    } finally {
        $watch.Stop()
        $row.elapsedMs = $watch.ElapsedMilliseconds
        [IO.File]::WriteAllText((Join-Path $out ($Name + '.stdout.log')), $row.stdout, $utf8)
        [IO.File]::WriteAllText((Join-Path $out ($Name + '.stderr.log')), $row.stderr, $utf8)
        $process.Dispose()
    }
    return $row
}
function Assert-Keys($Value, [string[]]$Keys) {
    if ($Value -isnot [Collections.IDictionary] -or (Compare-Object @($Value.Keys | Sort-Object) @($Keys | Sort-Object))) { throw 'Unexpected native JSON fields.' }
}
function Parse-Inspection([string]$Raw) {
    $reply = ConvertFrom-Json -InputObject $Raw -AsHashtable
    Assert-Keys $reply @('version', 'operation', 'verified', 'reason', 'nativeCode', 'approvedSource', 'files')
    if ($reply.version -ne 1 -or $reply.operation -cne 'inspect' -or $reply.verified -isnot [bool] -or $reply.reason -isnot [string] -or
        $reply.approvedSource -cne $approvedSource -or ($reply.nativeCode -isnot [int] -and $reply.nativeCode -isnot [long]) -or
        $reply.nativeCode -lt [int]::MinValue -or $reply.nativeCode -gt [int]::MaxValue -or $reply.files -isnot [array] -or $reply.files.Count -ne 3) { throw 'Unexpected native JSON contract.' }
    for ($index = 0; $index -lt 3; $index++) {
        $file = $reply.files[$index]
        Assert-Keys $file @('name', 'opened', 'size', 'sha256', 'sourcePinned', 'hashMatched', 'catalogVerified')
        if ($file.name -cne $names[$index] -or ($file.size -isnot [int] -and $file.size -isnot [long]) -or $file.size -lt 0 -or
            $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '^(?:[a-f0-9]{64})?$' -or
            @('opened', 'sourcePinned', 'hashMatched', 'catalogVerified').Where({ $file[$_] -isnot [bool] }).Count) { throw 'Unexpected native file observation.' }
        if ($file.sourcePinned -ne ($index -lt 2)) { throw 'Unexpected native source pin.' }
    }
    return $reply
}
function Invoke-Negative([string]$Name, [string[]]$Arguments, [string[]]$Reasons, [string]$Meaning) {
    $row = [ordered]@{ name = $Name; status = 'failed'; expectedExit = 2; expectedReasons = $Reasons; scope = $Meaning; process = $null; response = $null }
    try {
        Write-Output ('CASE ' + $Name + ' :: ' + $inspector + ' ' + (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '))
        $row.process = Invoke-OwnedProcess $Name $inspector $Arguments
        [Console]::Out.Write($row.process.stdout)
        [Console]::Error.Write($row.process.stderr)
        if (-not $row.process.exitConfirmed -or $row.process.terminationRequested -or $row.process.Contains('harnessError') -or $row.process.exitCode -ne 2 -or $row.process.stderr) { throw 'Native refusal process was not verified.' }
        $row.response = Parse-Inspection $row.process.stdout
        if ($row.response.verified -ne $false -or $row.response.reason -cnotin $Reasons) { throw 'Unexpected native refusal reason.' }
        if ($row.response.reason -in @('CATALOG_TRUST_REFUSED', 'CATALOG_SIGNER_REFUSED') -and $row.response.nativeCode -eq 0) { throw 'Missing actual native trust refusal.' }
        if ($row.response.reason -eq 'APPROVED_HASH_MISMATCH') {
            $target = if ($Name -eq 'tampered-inf') { 0 } else { 1 }
            if (-not $row.response.files[$target].opened -or $row.response.files[$target].hashMatched) { throw 'The tampered member hash was not refused.' }
        }
        $row.status = 'passed'
    } catch { $row['harnessError'] = 'EXPECTED_NATIVE_REFUSAL_NOT_VERIFIED' }
    $report.cases += $row
    Save-Report
    if ($null -ne $row.process -and -not $row.process.exitConfirmed) { throw 'Owned process exit unconfirmed; stop subsequent cases.' }
}

# One bounded child selects an optional offline fixture. GENERIC trust is not
# DRIVER_ACTION_VERIFY or proof that either prototype member is covered.
$catalogProbe = @'
$ErrorActionPreference = 'Stop'
$reply = [ordered]@{ version = 1; available = $false; reason = 'NO_OFFLINE_MICROSOFT_CATALOG'; examined = 0; selected = $null }
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ReviewOpsOfflineCatalog {
 [StructLayout(LayoutKind.Sequential)] struct FileInfo { public UInt32 size; public IntPtr path, file, subject; }
 [StructLayout(LayoutKind.Sequential)] struct Data {
  public UInt32 size; public IntPtr callback, sip; public UInt32 ui, revocation, choice; public IntPtr info;
  public UInt32 action; public IntPtr state, url; public UInt32 flags, context; public IntPtr settings;
 }
 [DllImport("wintrust.dll", ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref Data data);
 public static int Verify(string path) {
  IntPtr name=IntPtr.Zero, info=IntPtr.Zero;
  var data=new Data(); var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
  try {
   name=Marshal.StringToHGlobalUni(path);
   var file=new FileInfo { size=(UInt32)Marshal.SizeOf<FileInfo>(), path=name };
   info=Marshal.AllocHGlobal(Marshal.SizeOf<FileInfo>()); Marshal.StructureToPtr(file,info,false);
   data.size=(UInt32)Marshal.SizeOf<Data>(); data.ui=2; data.choice=1; data.info=info; data.action=1;
   data.flags=0x1010; // CACHE_ONLY_URL_RETRIEVAL | REVOCATION_CHECK_NONE.
   return WinVerifyTrust(new IntPtr(-1),ref action,ref data);
  } finally {
   if(data.state!=IntPtr.Zero) { data.action=2; WinVerifyTrust(new IntPtr(-1),ref action,ref data); }
   if(info!=IntPtr.Zero) Marshal.FreeHGlobal(info); if(name!=IntPtr.Zero) Marshal.FreeHGlobal(name);
  }
 }
}
"@
$root = Join-Path ([Environment]::SystemDirectory) 'CatRoot'
$watch = [Diagnostics.Stopwatch]::StartNew()
$options = [IO.EnumerationOptions]::new()
$options.RecurseSubdirectories = $true
$options.MaxRecursionDepth = 2
$options.AttributesToSkip = [IO.FileAttributes]::ReparsePoint
$options.IgnoreInaccessible = $true
$iterator = [IO.Directory]::EnumerateFiles($root, '*.cat', $options).GetEnumerator()
try {
 while ($reply.examined -lt 32 -and $watch.ElapsedMilliseconds -lt 7000 -and $iterator.MoveNext()) {
  $reply.examined++
  $path = $iterator.Current
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 1 -or $item.Length -gt 4194304) { continue }
  if ([ReviewOpsOfflineCatalog]::Verify($path) -ne 0) { continue }
  $certificate = $null
  try {
   $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($path))
   if ($certificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { continue }
   $reply.available=$true; $reply.reason='OFFLINE_GENERIC_MICROSOFT_SIGNATURE_ONLY'
   $reply.selected=[ordered]@{ path=$path; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); genericVerifyCode=0; signerOrganization='Microsoft Corporation' }
   break
  } finally { if ($null -ne $certificate) { $certificate.Dispose() } }
 }
} finally { $iterator.Dispose() }
} catch { $reply.reason='OFFLINE_CATALOG_SELECTION_UNAVAILABLE' }
$reply | ConvertTo-Json -Depth 6 -Compress
'@

$baseline = $null
try {
    $baseline = Snapshot-Original
    if ($baseline[0].sha256 -cne $approvedHashes[0] -or $baseline[1].sha256 -cne $approvedHashes[1]) { throw 'Original package differs from the approved component bytes.' }
    $report.originalPackage.files = $baseline
    Save-Report
    Invoke-Negative 'original-unsigned' @('--inspect', $original) 'CATALOG_TRUST_REFUSED' 'Actual original unsigned catalog refusal; not signed package acceptance.'
    $inf = New-PackageCopy 'tampered-inf'
    [IO.File]::AppendAllText((Join-Path $inf $names[0]), ([Environment]::NewLine + '; owned admission test mutation' + [Environment]::NewLine), $utf8)
    Invoke-Negative 'tampered-inf' @('--inspect', $inf) 'APPROVED_HASH_MISMATCH' 'Owned INF copy differs from approved bytes.'
    $dll = New-PackageCopy 'tampered-dll'
    $file = [IO.File]::Open((Join-Path $dll $names[1]), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $file.Position = $file.Length - 1; $byte = $file.ReadByte(); $file.Position = $file.Length - 1; $file.WriteByte([byte]($byte -bxor 1)) } finally { $file.Dispose() }
    Invoke-Negative 'tampered-dll' @('--inspect', $dll) 'APPROVED_HASH_MISMATCH' 'Owned DLL copy differs from approved bytes.'
    $missing = New-PackageCopy 'missing-cat'
    [IO.File]::Delete((Join-Path $missing $names[2]))
    Invoke-Negative 'missing-cat' @('--inspect', $missing) 'OPEN_FAILED' 'Required catalog is absent from the owned copy.'
    $extra = New-PackageCopy 'extra-entry'
    [IO.File]::WriteAllText((Join-Path $extra 'unexpected.txt'), 'Owned extra entry.', $utf8)
    Invoke-Negative 'extra-entry' @('--inspect', $extra) 'UNEXPECTED_ENTRIES' 'An owned fourth entry is not admitted.'
    $linked = New-PackageCopy 'hardlinked-member'
    New-Item -ItemType HardLink -Path (Join-Path $fixtures 'owned-dll-alias.bin') -Target (Join-Path $linked $names[1]) | Out-Null
    Invoke-Negative 'hardlinked-member' @('--inspect', $linked) 'UNSAFE_FILE' 'Three package entries; only the copied DLL has an alias outside that owned package.'
    $junctionTarget = New-PackageCopy 'junction-target'
    $junction = Join-Path $fixtures 'junction-package'
    New-Item -ItemType Junction -Path $junction -Target $junctionTarget | Out-Null
    Invoke-Negative 'junction-package' @('--inspect', $junction) 'UNSAFE_PATH' 'Owned reparse path to another owned copy; no original path is linked.'
    Invoke-Negative 'unknown-arguments' @('--unsupported') 'INVALID_ARGUMENT' 'Unsupported command-line operation is refused.'

    $probeTemp = Join-Path $out 'probe-temp'
    [IO.Directory]::CreateDirectory($probeTemp) | Out-Null
    $probe = Invoke-OwnedProcess 'optional-catalog-selection' (Join-Path $PSHOME 'pwsh.exe') @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($catalogProbe))) @{ TEMP = $probeTemp; TMP = $probeTemp }
    $report.optionalCatalogSelection = $probe
    $selection = $null
    if ($probe.exitConfirmed -and -not $probe.terminationRequested -and -not $probe.Contains('harnessError') -and $probe.exitCode -eq 0 -and -not $probe.stderr) {
        try {
            $candidate = ConvertFrom-Json -InputObject $probe.stdout -AsHashtable
            Assert-Keys $candidate @('version', 'available', 'reason', 'examined', 'selected')
            if ($candidate.version -eq 1 -and $candidate.available -eq $true -and $candidate.examined -ge 1 -and $candidate.examined -le 32) {
                Assert-Keys $candidate.selected @('path', 'bytes', 'sha256', 'genericVerifyCode', 'signerOrganization')
                $selected = $candidate.selected
                $catRoot = (Join-Path ([Environment]::SystemDirectory) 'CatRoot').TrimEnd('\') + '\'
                $path = Assert-OrdinaryPath $selected.path $false
                if ($path.StartsWith($catRoot, [StringComparison]::OrdinalIgnoreCase) -and $selected.genericVerifyCode -eq 0 -and
                    $selected.signerOrganization -ceq 'Microsoft Corporation' -and $selected.sha256 -cmatch '^[a-f0-9]{64}$' -and
                    (Hash $path) -ceq $selected.sha256) { $selection = $selected }
            }
        } catch { $selection = $null }
    }
    if (-not $probe.exitConfirmed) { throw 'Optional owned process exit unconfirmed.' }
    if ($null -eq $selection) {
        $report.cases += [ordered]@{ name = 'unrelated-microsoft-catalog'; status = 'skipped'; reason = 'NO_VERIFIED_OFFLINE_FIXTURE'; scope = 'No valid unrelated catalog was selected within the bounded offline probe; no native pass claimed.' }
    } else {
        $unrelated = New-PackageCopy 'unrelated-microsoft-catalog'
        $copy = Join-Path $unrelated $names[2]
        try {
            [IO.File]::Copy($selection.path, $copy, $true)
            if ((Hash $copy) -cne $selection.sha256) { throw 'Selected catalog copy differs.' }
            Invoke-Negative 'unrelated-microsoft-catalog' @('--inspect', $unrelated) @('CATALOG_TRUST_REFUSED', 'CATALOG_SIGNER_REFUSED') 'A GENERIC-verified unrelated Microsoft catalog is refused by the driver package policy; this does not isolate trust versus member coverage.'
        } finally {
            # Never retain OS catalog or certificate copies as upload artifacts.
            if (Test-Path -LiteralPath $copy) { [IO.File]::Delete($copy) }
        }
    }
    $report.status = if (@($report.cases | Where-Object status -eq 'failed').Count -eq 0 -and @($report.cases | Where-Object status -eq 'passed').Count -ge 8 -and $report.cases.Count -eq 9) { 'passed-negative-admission-only' } else { 'failed' }
} catch {
    $report.status = 'failed'
    $report['harnessError'] = 'PACKAGE_ADMISSION_TESTS_NOT_VERIFIED'
} finally {
    if ($null -ne $baseline) {
        try {
            $after = Snapshot-Original
            if (($baseline | ConvertTo-Json -Depth 5 -Compress) -cne ($after | ConvertTo-Json -Depth 5 -Compress) -or (Hash $inspector) -cne $report.inspector.sha256) { throw 'Original package or inspector changed.' }
            $report.originalPackage.unchanged = $true
        } catch {
            $report.originalPackage.unchanged = $false
            $report.status = 'failed'
            $report['preservationError'] = 'ORIGINAL_PACKAGE_OR_INSPECTOR_NOT_VERIFIED'
        }
    }
    $report.counts = [ordered]@{
        passed = @($report.cases | Where-Object status -eq 'passed').Count
        failed = @($report.cases | Where-Object status -eq 'failed').Count
        skipped = @($report.cases | Where-Object status -eq 'skipped').Count
        total = $report.cases.Count
    }
    $report['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    Save-Report
}
Write-Output ([ordered]@{
    version = 1
    scope = $report.scope
    status = $report.status
    counts = $report.counts
    originalPackageUnchanged = $report.originalPackage.unchanged
    positiveSignedDriverAdmissionStatus = $report.positiveSignedDriverAdmissionStatus
    receipt = $reportPath
} | ConvertTo-Json -Depth 4 -Compress)
if ($report.status -ne 'passed-negative-admission-only') { throw 'Native negative package admission checks did not pass.' }
