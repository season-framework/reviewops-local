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
    scope = 'Unsigned x64 UMDF/IddCx prototype compilation and static inspection'
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

    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio discovery is unavailable.' }
    $vs = (& $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -property installationPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'Supported Visual Studio 2022 is required.' }
    $msbuild = Join-Path $vs 'MSBuild\Current\Bin\MSBuild.exe'
    if (-not (Test-Path -LiteralPath $msbuild)) { throw 'MSBuild is unavailable.' }
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
    & $msbuild (Join-Path $root 'ReviewOpsVirtualDisplay.vcxproj') /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" /p:SignMode=Off /p:EnableInf2cat=false 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'msbuild.log')
    if ($LASTEXITCODE -ne 0) { throw 'The native driver compilation failed.' }
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
    $record['outputs'] = @(Get-ChildItem -LiteralPath $out -File -Recurse |
        Where-Object { $_.Extension -in @('.dll', '.inf', '.exe') } |
        ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'The build changed committed prototype inputs.' }
    $record['status'] = 'passed-compilation-only'
} catch {
    $record['status'] = 'failed'
    $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
