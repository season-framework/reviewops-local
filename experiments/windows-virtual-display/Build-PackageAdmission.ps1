# Compile only package admission and reuse the accepted original driver fixture.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required.' }
$root = $PSScriptRoot
$out = Join-Path $root '_out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$record = [ordered]@{
    schema = 1; status = 'running'; startedAtUTC = [DateTime]::UtcNow.ToString('o')
    scope = 'Native package-admission component and negative cases against an original fixture'
    driverRebuilt = $false; driverInstalled = $false; driverExecuted = $false
    certificateImported = $false; bootSecurityChanged = $false; fullProductQA = $false
    approvedSignedPositivePathTested = $false
}
try {
    $source = (& git -C $root rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $source -notmatch '^[0-9a-f]{40}$') { throw 'Source identity unavailable.' }
    $record['source'] = $source
    if ($env:GITHUB_ACTIONS -eq 'true') {
        if ($env:GITHUB_REPOSITORY -ne 'season-framework/reviewops-local' -or $env:GITHUB_REF -ne 'refs/heads/codex/windows-virtual-display-prototype' -or
            $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_SHA -ne $source -or $env:GITHUB_RUN_ATTEMPT -ne '1') { throw 'The original CI source/attempt binding differs.' }
        $record['producer'] = [ordered]@{ runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; event = $env:GITHUB_EVENT_NAME }
    }
    $dirty = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the admission component inputs before building.' }
    $baseline = Get-Content -LiteralPath (Join-Path $out 'admission-baseline-source.json') -Raw | ConvertFrom-Json
    if ($baseline.archiveSHA256 -ne 'a0c7e8c1cd0c96047eb430356d78a2c6c3d29fcd6428872b5bdee8c2b4876da8' -or $baseline.source -ne '884e87504c5b56133e46bbeb65cae6d441baa1ba') { throw 'The accepted original fixture is unavailable.' }
    $record['fixture'] = $baseline
    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = (& $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -property installationPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'Supported Visual Studio 2022 is required.' }
    $msbuild = Join-Path $vs 'MSBuild\Current\Bin\amd64\MSBuild.exe'
    $vcVersion = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    if ($vcVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid native compiler version.' }
    $compiler = Join-Path $vs ("VC\Tools\MSVC\" + $vcVersion + '\bin\Hostx64\x64\cl.exe')
    $nuget = (Get-Command nuget.exe -ErrorAction Stop).Source
    $record['tools'] = [ordered]@{
        vcToolsVersion = $vcVersion
        compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
        compilerSHA256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
        msbuildVersion = (Get-Item -LiteralPath $msbuild).VersionInfo.FileVersion
        msbuildSHA256 = (Get-FileHash -LiteralPath $msbuild -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    & $nuget restore (Join-Path $root 'packages.config') -PackagesDirectory (Join-Path $root 'packages') -NonInteractive -Source 'https://api.nuget.org/v3/index.json' 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'package-admission-restore.log')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Microsoft SDK restore failed.' }
    $pins = [ordered]@{
        'Microsoft.Windows.WDK.x64' = 'c393d03dfb640b5c92f546b32f6770ef68cd3aaf691956e7d66d8e2c28a1b55e'
        'Microsoft.Windows.SDK.CPP' = '5d31b38205bdd9ac761b4cb39fbbc6b7209b01c11194324afc674d7d119483a0'
        'Microsoft.Windows.SDK.CPP.x64' = 'c29ce7a4641cb37ee32ebb8078cc65cfbabc7025076bcfba869039204b1e960d'
    }
    $record['packages'] = @()
    foreach ($id in $pins.Keys) {
        $path = Join-Path $root ("packages\$id.10.0.26100.6584\$id.10.0.26100.6584.nupkg")
        $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sha -ne $pins[$id]) { throw 'A pinned toolchain package differs from its original bytes.' }
        $record['packages'] += [ordered]@{ id = $id; version = '10.0.26100.6584'; sha256 = $sha }
    }
    & $msbuild (Join-Path $root 'ReviewOpsPackageInspect.vcxproj') /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'package-admission-msbuild.log')
    if ($LASTEXITCODE -ne 0) { throw 'Native package-admission compilation failed.' }
    $inspector = Join-Path $out 'admission\ReviewOpsDriverPackageInspect.exe'
    if (-not (Test-Path -LiteralPath $inspector)) { throw 'The package inspector was not produced.' }
    $record['inspector'] = [ordered]@{ name = 'ReviewOpsDriverPackageInspect.exe'; bytes = (Get-Item -LiteralPath $inspector).Length; sha256 = (Get-FileHash -LiteralPath $inspector -Algorithm SHA256).Hash.ToLowerInvariant() }
    $testOut = Join-Path $out 'admission-tests'
    & (Join-Path $root 'Test-PackageAdmission.ps1') -InspectorPath $inspector -PackagePath (Join-Path $out 'admission-baseline\unsigned-driver-package') -OutputDirectory $testOut
    $testResult = Get-Content -LiteralPath (Join-Path $testOut 'package-admission-results.json') -Raw | ConvertFrom-Json
    if ($testResult.status -ne 'passed-negative-admission-only' -or $testResult.counts.failed -ne 0 -or $testResult.counts.passed -lt 8 -or $testResult.counts.total -ne 9 -or
        $testResult.positiveSignedDriverAdmissionProven -ne $false -or $testResult.originalPackage.unchanged -ne $true) { throw 'The required negative admission cases did not pass.' }
    $record['cases'] = $testResult
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'Admission validation changed committed source inputs.' }
    $record['status'] = 'passed-admission-negative-cases'
} catch {
    $record['status'] = 'failed'; $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $out 'package-admission-build.json') -Encoding utf8
}
