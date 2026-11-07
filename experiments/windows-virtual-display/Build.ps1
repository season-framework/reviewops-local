# Compile an unsigned experiment. This script never installs or starts a driver.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This build requires a native Windows host.' }
$root = $PSScriptRoot
$out = Join-Path $root '_out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$reportPath = Join-Path $out 'build-report.json'
$record = [ordered]@{
    schema = 1
    scope = 'Unsigned x64 prototype build, target INF validation, catalog and no-driver client admission'
    status = 'running'
    startedAtUTC = [DateTime]::UtcNow.ToString('o')
    driverInstalled = $false
    driverExecuted = $false
    nativeMonitorLifecycleTested = $false
    fullProductQA = $false
    kitVersion = '10.0.26100.6584'
}
try {
    $source = (& git -C $root rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $source -notmatch '^[0-9a-f]{40}$') { throw 'Source identity unavailable.' }
    $record['source'] = $source
    if ($env:GITHUB_ACTIONS -eq 'true') {
        if ($env:GITHUB_REPOSITORY -ne 'season-framework/reviewops-local' -or
            $env:GITHUB_REF -ne 'refs/heads/codex/windows-virtual-display-prototype' -or
            $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_SHA -ne $source) {
            throw 'The CI producer does not match the reviewed prototype branch/source.'
        }
        $record['producer'] = [ordered]@{
            repository = $env:GITHUB_REPOSITORY
            runId = $env:GITHUB_RUN_ID
            runAttempt = $env:GITHUB_RUN_ATTEMPT
            event = $env:GITHUB_EVENT_NAME
        }
    }
    $dirty = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the prototype inputs before building.' }
    if (Test-Path Env:PRIVATE_DRIVER_PACKAGE) { throw 'PRIVATE_DRIVER_PACKAGE would override the reviewed driver identity.' }
    $identity = Get-Content -LiteralPath (Join-Path $root 'DriverPackage.json') -Raw | ConvertFrom-Json
    if ($identity.schema -ne 1 -or $identity.version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $identity.dateUTC -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Invalid prototype driver identity.' }
    foreach ($part in $identity.version.Split('.')) {
        if ([uint64]$part -gt 65535) { throw 'A driver version component exceeds the INF range.' }
    }
    $identityDate = [DateTime]::ParseExact($identity.dateUTC, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    if ($identityDate.Date -gt [DateTime]::UtcNow.Date) { throw 'The driver date cannot be in the UTC future.' }
    $driverDate = $identityDate.ToString('MM/dd/yyyy', [Globalization.CultureInfo]::InvariantCulture)
    $record['driverPackageIdentity'] = [ordered]@{ version = $identity.version; dateUTC = $identity.dateUTC; generatedINFVerified = $false }

    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio discovery is unavailable.' }
    $vs = (& $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -property installationPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'Supported Visual Studio 2022 is required.' }
    # The pinned WDK ships native x64 InfVerif; the 32-bit host would seek a missing x86 DLL.
    $msbuild = Join-Path $vs 'MSBuild\Current\Bin\amd64\MSBuild.exe'
    if (-not (Test-Path -LiteralPath $msbuild)) { throw 'Native x64 MSBuild is unavailable.' }
    $toolset = Join-Path $vs 'MSBuild\Microsoft\VC\v170\Platforms\x64\PlatformToolsets\WindowsUserModeDriver10.0\Toolset.props'
    if (-not (Test-Path -LiteralPath $toolset)) { throw 'The WDK Visual Studio extension is required; no machine installation was attempted.' }
    $vcVersion = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    if ($vcVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'The MSVC toolset version is invalid.' }
    $compiler = Join-Path $vs ("VC\Tools\MSVC\" + $vcVersion + '\bin\Hostx64\x64\cl.exe')
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'The native x64 C++ compiler is unavailable.' }
    $nuget = (Get-Command nuget.exe -ErrorAction Stop).Source
    $record['tools'] = [ordered]@{
        vcToolsVersion = $vcVersion
        compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
        compilerSHA256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
        msbuildVersion = (Get-Item -LiteralPath $msbuild).VersionInfo.FileVersion
        msbuildHostArchitecture = 'AMD64'
        msbuildSHA256 = (Get-FileHash -LiteralPath $msbuild -Algorithm SHA256).Hash.ToLowerInvariant()
        nugetVersion = (Get-Item -LiteralPath $nuget).VersionInfo.FileVersion
        nugetSHA256 = (Get-FileHash -LiteralPath $nuget -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    & $nuget restore (Join-Path $root 'packages.config') -PackagesDirectory (Join-Path $root 'packages') -NonInteractive -Source 'https://api.nuget.org/v3/index.json' 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'restore.log')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Microsoft toolchain restore failed.' }
    $packageRecords = @()
    foreach ($id in @('Microsoft.Windows.WDK.x64', 'Microsoft.Windows.SDK.CPP', 'Microsoft.Windows.SDK.CPP.x64')) {
        $package = Join-Path $root ("packages\" + $id + '.10.0.26100.6584\' + $id + '.10.0.26100.6584.nupkg')
        if (-not (Test-Path -LiteralPath $package)) { throw "Restored package is missing: $id" }
        $hash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($id -eq 'Microsoft.Windows.WDK.x64' -and $hash -ne 'c393d03dfb640b5c92f546b32f6770ef68cd3aaf691956e7d66d8e2c28a1b55e') {
            throw 'The original Microsoft WDK package bytes differ from the reviewed package.'
        }
        $packageRecords += [ordered]@{ id = $id; version = '10.0.26100.6584'; sha256 = $hash; bytes = (Get-Item -LiteralPath $package).Length }
    }
    $record['packages'] = $packageRecords
    # This x64 WDK package has no x86 stampinf; avoid the legacy targets' x86 fallback.
    $infToolPath = Join-Path $root 'packages\Microsoft.Windows.WDK.x64.10.0.26100.6584\c\bin\10.0.26100.0\x64'
    $stampInf = Join-Path $infToolPath 'stampinf.exe'
    if (-not (Test-Path -LiteralPath $stampInf)) { throw 'The pinned native x64 INF stamping tool is unavailable.' }
    $record['infStampingTool'] = [ordered]@{
        architecture = 'AMD64'
        sha256 = (Get-FileHash -LiteralPath $stampInf -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = (Get-Item -LiteralPath $stampInf).Length
    }
    & $msbuild (Join-Path $root 'ReviewOpsVirtualDisplay.vcxproj') /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" "/p:InfToolPath=$infToolPath" /p:InfToolArchitecture=Native64Bit "/p:ReviewOpsDriverDate=$driverDate" "/p:ReviewOpsDriverVersion=$($identity.version)" /p:SignMode=Off /p:EnableInf2cat=false 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'msbuild.log')
    if ($LASTEXITCODE -ne 0) { throw 'The native driver compilation failed.' }
    $generatedInf = Join-Path $out 'ReviewOpsVirtualDisplay.inf'
    $infText = Get-Content -LiteralPath $generatedInf -Raw
    $driverVerPattern = '(?im)^\s*DriverVer\s*=\s*' + [regex]::Escape($driverDate) + '\s*,\s*' + [regex]::Escape($identity.version) + '\s*$'
    if ([regex]::Matches($infText, $driverVerPattern).Count -ne 1) { throw 'Generated INF identity differs from DriverPackage.json.' }
    $record['driverPackageIdentity']['generatedINFVerified'] = $true
    $selectionReport = Join-Path $out 'inf-section-selection.json'
    & (Join-Path $root 'Inspect-InfSelection.ps1') -InfPath $generatedInf -OutputPath $selectionReport
    $selection = Get-Content -LiteralPath $selectionReport -Raw | ConvertFrom-Json
    if ($selection.status -ne 'passed-read-only-section-selection') { throw 'Native INF section selection did not pass.' }
    $record['infSectionSelection'] = $selection
    foreach ($profile in $selection.profiles) {
        Write-Output "SetupAPI build $($profile.BuildNumber): $($profile.ModelsSection) -> $($profile.Models.ActualInstallSection -join ', ')"
    }
    $infVerif = Join-Path $root 'packages\Microsoft.Windows.WDK.x64.10.0.26100.6584\c\tools\10.0.26100.0\x64\infverif.exe'
    if (-not (Test-Path -LiteralPath $infVerif)) { throw 'The pinned native INF verifier is unavailable.' }
    $record['infVerifier'] = [ordered]@{
        sha256 = (Get-FileHash -LiteralPath $infVerif -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = (Get-Item -LiteralPath $infVerif).Length
    }
    $profiles = @()
    foreach ($build in @(17134, 19045, 22000, 26100)) {
        $target = "NTAMD64.10.0...$build"
        $log = Join-Path $out ("inf-applicability-$build.log")
        Write-Output "INF static applicability: /u /v /info /osver $target ReviewOpsVirtualDisplay.inf"
        & $infVerif /u /v /info /osver $target $generatedInf 2>&1 | Tee-Object -FilePath $log
        $code = $LASTEXITCODE
        $profiles += [ordered]@{ targetOS = $target; exitCode = $code; log = "inf-applicability-$build.log"; installedOrExecuted = $false }
        $record['infApplicability'] = $profiles
        if ($code -ne 0) { throw "INF static validation failed for $target." }
    }
    & $msbuild (Join-Path $root 'ReviewOpsDisplayControl.vcxproj') /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'client-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'The native control client compilation failed.' }
    $client = Join-Path $out 'ReviewOpsVirtualDisplayClient.exe'
    if (-not (Test-Path -LiteralPath $client)) { throw 'The expected control client was not produced.' }
    $record['client'] = [ordered]@{
        name = 'ReviewOpsVirtualDisplayClient.exe'
        bytes = (Get-Item -LiteralPath $client).Length
        sha256 = (Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant()
        executed = $false
        monitorControlTested = $false
    }
    $admissionResults = @()
    $admissionCases = @(
        @{ name = 'list-without-driver'; arguments = @('--list'); exitCode = 0; operation = 'list'; error = $null },
        @{ name = 'refuse-unlisted-instance'; arguments = @('--control', 'ROOT\REVIEWOPS_UNINSTALLED_QA_INSTANCE'); exitCode = 2; operation = 'admission'; error = 'SELECTED_INTERFACE_UNAVAILABLE' },
        @{ name = 'refuse-unsupported-arguments'; arguments = @('--unsupported'); exitCode = 2; operation = 'arguments'; error = 'USE_LIST_OR_CONTROL_EXACT_INSTANCE_ID' }
    )
    foreach ($case in $admissionCases) {
        $start = [Diagnostics.ProcessStartInfo]::new($client)
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($argument in $case.arguments) { $start.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        try {
            if (-not $process.Start()) { throw 'The client admission process could not start.' }
            $record['client']['executed'] = $true
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(10000)) {
                $process.Kill()
                if (-not $process.WaitForExit(2000)) { throw 'The owned admission process did not exit after termination.' }
                throw 'The client admission check exceeded its deadline.'
            }
            $raw = $stdout.GetAwaiter().GetResult()
            $errorText = $stderr.GetAwaiter().GetResult()
            $raw | Set-Content -LiteralPath (Join-Path $out ($case.name + '.log')) -Encoding utf8
            if ($process.ExitCode -ne $case.exitCode -or $errorText) { throw "Unexpected client admission exit: $($case.name)" }
            $reply = $raw | ConvertFrom-Json
            if ($reply.schema -ne 1 -or $reply.scope -ne 'build-only-virtual-display-prototype' -or $reply.operation -ne $case.operation) { throw 'Unexpected client admission response.' }
            if ($case.error) {
                if ($reply.ok -ne $false -or $reply.error -ne $case.error) { throw 'The client did not refuse the unsupported request.' }
            } elseif ($reply.ok -ne $true -or @($reply.devices).Count -ne 0 -or $reply.availability -ne 'not-enumerated' -or $reply.deviceOpened -ne $false -or $reply.displayChangeRequested -ne $false) {
                throw 'The fresh build host did not report an empty, unopened prototype interface class.'
            }
            $admissionResults += [ordered]@{ name = $case.name; exitCode = $process.ExitCode; response = $reply; status = 'passed' }
        } finally { $process.Dispose() }
    }
    $record['client']['noDriverAdmission'] = $admissionResults
    $dll = Join-Path $out 'ReviewOpsVirtualDisplay.dll'
    if (-not (Test-Path -LiteralPath $dll)) { throw 'The expected driver DLL was not produced.' }
    $stream = [IO.File]::OpenRead($dll)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Missing DOS executable header.' }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -gt ($stream.Length - 24)) { throw 'Invalid PE header offset.' }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Expected a native AMD64 PE image.' }
        $stream.Position = $peOffset + 22
        if (($reader.ReadUInt16() -band 0x2000) -eq 0) { throw 'Expected a DLL image.' }
    } finally { $reader.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $dll
    if ($signature.Status -ne 'NotSigned') { throw 'The build-only experiment unexpectedly produced a signed image.' }
    $record['binary'] = [ordered]@{
        name = 'ReviewOpsVirtualDisplay.dll'
        bytes = (Get-Item -LiteralPath $dll).Length
        sha256 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
        machine = 'AMD64'
        signature = [string]$signature.Status
    }
    # Prepare only this fresh output directory; no driver is staged or installed.
    $packageDir = Join-Path $out 'unsigned-driver-package'
    New-Item -ItemType Directory -Path $packageDir -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $dll -Destination (Join-Path $packageDir 'ReviewOpsVirtualDisplay.dll')
    Copy-Item -LiteralPath $generatedInf -Destination (Join-Path $packageDir 'ReviewOpsVirtualDisplay.inf')
    $inf2Cat = Join-Path $root 'packages\Microsoft.Windows.WDK.x64.10.0.26100.6584\c\bin\10.0.26100.0\x86\Inf2Cat.exe'
    if (-not (Test-Path -LiteralPath $inf2Cat)) { throw 'The pinned catalog generator is unavailable.' }
    $catalogTargets = '10_RS4_X64,10_VB_X64,10_CO_X64,10_GE_X64'
    Write-Output "Unsigned catalog preparation: Inf2Cat /driver:unsigned-driver-package /os:$catalogTargets /verbose"
    & $inf2Cat "/driver:$packageDir" "/os:$catalogTargets" /verbose 2>&1 | Tee-Object -FilePath (Join-Path $out 'inf2cat.log')
    if ($LASTEXITCODE -ne 0) { throw 'The unsigned catalog/package-layout validation failed.' }
    $catalog = Join-Path $packageDir 'ReviewOpsVirtualDisplay.cat'
    if (-not (Test-Path -LiteralPath $catalog)) { throw 'The unsigned driver catalog was not produced.' }
    $catalogSignature = Get-AuthenticodeSignature -LiteralPath $catalog
    if ($catalogSignature.Status -ne 'NotSigned') { throw 'The prototype catalog unexpectedly has a signature.' }
    $record['unsignedDriverPackage'] = [ordered]@{
        inf2catSHA256 = (Get-FileHash -LiteralPath $inf2Cat -Algorithm SHA256).Hash.ToLowerInvariant()
        targets = $catalogTargets.Split(',')
        catalogSignature = [string]$catalogSignature.Status
        installed = $false
        files = @(Get-ChildItem -LiteralPath $packageDir -File | ForEach-Object {
            [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        })
    }
    $record['outputs'] = @(Get-ChildItem -LiteralPath $out -File -Recurse |
        Where-Object { $_.Extension -in @('.dll', '.inf', '.exe', '.cat') } |
        ForEach-Object { [ordered]@{ name = $_.Name; relativePath = [IO.Path]::GetRelativePath($out, $_.FullName); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'The build changed committed prototype inputs.' }
    $record['status'] = 'passed-build-and-no-driver-admission'
} catch {
    $record['status'] = 'failed'
    $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
