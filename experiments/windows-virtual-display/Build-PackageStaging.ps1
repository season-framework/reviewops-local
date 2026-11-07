# Compile production staging and test only owned copy/cleanup primitives.
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
    scope = 'Protected package staging primitives on native Windows; no signed production admission or installation'
    driverRebuilt = $false; driverInstalled = $false; driverExecuted = $false
    certificateImported = $false; bootSecurityChanged = $false; fullProductQA = $false
    positiveSignedProductionStageTested = $false
    admissionBaselineSource = '860f2478d781fc4ba4a1c9dead78825fc369f25e'
    admissionBaselineRunId = 42340672354
    unchangedAdmissionCasesRepeated = $false
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
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the staging component inputs before building.' }
    $record['inputs'] = @()
    foreach ($name in @('PackageAdmission.h', 'PackageAdmission.cpp', 'PackageStaging.h', 'PackageStaging.cpp', 'PackageStagingTests.cpp',
                       'ReviewOpsPackageStaging.vcxproj', 'ReviewOpsPackageStagingTests.vcxproj', 'Directory.Build.props', 'packages.config')) {
        $path = Join-Path $root $name
        $record['inputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $acceptedAdmissionInputs = @{
        'PackageAdmission.h' = 'c34452a3cefc48b52d796ae74b597c3042ecd8e182b830cfac4515ac856df88d'
        'PackageAdmission.cpp' = '7501e9002115864e447a91bdbddc25fc9b621edc158ba19ece53cf3e046dbc0e'
    }
    foreach ($name in $acceptedAdmissionInputs.Keys) {
        $actual = @($record['inputs'] | Where-Object { $_.name -eq $name })
        if ($actual.Count -ne 1 -or $actual[0].sha256 -ne $acceptedAdmissionInputs[$name]) { throw 'Changed admission inputs require their own accepted native evidence before reusing the baseline.' }
    }
    $record['admissionBaselineInputsMatched'] = $true
    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = (& $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -property installationPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'Supported Visual Studio 2022 is required.' }
    $msbuild = Join-Path $vs 'MSBuild\Current\Bin\amd64\MSBuild.exe'
    $vcVersion = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    if ($vcVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid native compiler version.' }
    $compiler = Join-Path $vs ("VC\Tools\MSVC\" + $vcVersion + '\bin\Hostx64\x64\cl.exe')
    $record['tools'] = [ordered]@{
        vcToolsVersion = $vcVersion
        compilerVersion = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
        compilerSHA256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
        msbuildVersion = (Get-Item -LiteralPath $msbuild).VersionInfo.FileVersion
        msbuildSHA256 = (Get-FileHash -LiteralPath $msbuild -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $nuget = (Get-Command nuget.exe -ErrorAction Stop).Source
    & $nuget restore (Join-Path $root 'packages.config') -PackagesDirectory (Join-Path $root 'packages') -NonInteractive -Source 'https://api.nuget.org/v3/index.json' 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'package-staging-restore.log')
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
    foreach ($project in @('ReviewOpsPackageStaging', 'ReviewOpsPackageStagingTests')) {
        & $msbuild (Join-Path $root ($project + '.vcxproj')) /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" 2>&1 |
            Tee-Object -FilePath (Join-Path $out ('package-staging-' + $project + '-msbuild.log'))
        if ($LASTEXITCODE -ne 0) { throw 'Native package-staging compilation failed.' }
    }
    $record['outputs'] = @()
    foreach ($name in @('ReviewOpsPackageStaging.lib', 'ReviewOpsPackageStagingTests.exe')) {
        $path = Join-Path $out ('staging\' + $name)
        $record['outputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $binary = Join-Path $out 'staging\ReviewOpsPackageStagingTests.exe'
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $binary
    $info.ArgumentList.Add('--self-test')
    $info.WorkingDirectory = Join-Path $out 'staging'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($name in @($info.Environment.Keys)) {
        if ($name -match '(?i)TOKEN|SECRET|PASSWORD|CREDENTIAL') { $info.Environment.Remove($name) | Out-Null }
    }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $invocation = [ordered]@{
        executable = $binary; arguments = @('--self-test'); started = $false; timeoutMs = 60000
        exitConfirmed = $false; terminationRequested = $false; exitCode = $null
        stdout = ''; stderr = ''; streamsDrained = $false; totalDeadlineMs = 62000
    }
    $record['process'] = $invocation
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stdoutTask = $null; $stderrTask = $null
    try {
        if (-not $process.Start()) { throw 'The native staging tests did not start.' }
        $invocation['started'] = $true; $invocation['pid'] = $process.Id
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        $invocation['startTimeUTC'] = $process.StartTime.ToUniversalTime().ToString('o')
        $invocation['exitConfirmed'] = $process.WaitForExit([int][Math]::Max(0, 60000 - $watch.ElapsedMilliseconds))
    } finally {
        # An exception after launch still retires only this exact Process. Neither
        # termination nor stream observation can extend the total 62-second wait.
        if ($invocation['started'] -and -not $invocation['exitConfirmed']) {
            try {
                if (-not $process.HasExited) { $invocation['terminationRequested'] = $true; $process.Kill() }
                $invocation['exitConfirmed'] = $process.WaitForExit([int][Math]::Max(0, 62000 - $watch.ElapsedMilliseconds))
            } catch { $invocation['cleanupError'] = 'OWNED_PROCESS_EXIT_UNCONFIRMED' }
        }
        if ($invocation['exitConfirmed']) {
            $invocation['exitCode'] = $process.ExitCode
            if ($null -ne $stdoutTask -and $null -ne $stderrTask) {
                try {
                    $drains = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask))
                    $invocation['streamsDrained'] = $drains.Wait([int][Math]::Max(0, 62000 - $watch.ElapsedMilliseconds))
                    if ($invocation['streamsDrained']) {
                        $invocation['stdout'] = $stdoutTask.GetAwaiter().GetResult()
                        $invocation['stderr'] = $stderrTask.GetAwaiter().GetResult()
                    }
                } catch { $invocation['streamsDrained'] = $false; $invocation['streamError'] = 'OWNED_PROCESS_STREAMS_UNCONFIRMED' }
            }
        }
        $invocation['elapsedMs'] = $watch.ElapsedMilliseconds
        [IO.File]::WriteAllText((Join-Path $out 'package-staging-tests-stdout.log'), $invocation['stdout'], [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $out 'package-staging-tests-stderr.log'), $invocation['stderr'], [Text.UTF8Encoding]::new($false))
        $process.Dispose()
    }
    Write-Host 'COMMAND ReviewOpsPackageStagingTests.exe --self-test'
    Write-Host $invocation['stdout']
    if ($invocation['stderr']) { Write-Host $invocation['stderr'] }
    if (-not $invocation['exitConfirmed'] -or -not $invocation['streamsDrained'] -or $invocation['terminationRequested'] -or $invocation['exitCode'] -ne 0 -or $invocation['stderr']) { throw 'Native staging tests did not finish successfully.' }
    $lines = @($invocation['stdout'] -split '\r?\n' | Where-Object { $_.Trim() })
    $values = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    $cases = @($values | Where-Object { $_.type -eq 'case' })
    $summary = @($values | Where-Object { $_.type -eq 'summary' })
    $expectedNames = @('elevated-process-context', 'impersonated-thread-refused', 'protected-stage-acl', 'retained-handle-copy',
                       'empty-source-refused', 'oversize-source-refused', 'extra-entry-refused-and-preserved', 'staged-mutation-fences',
                       'cleanup-identity-mismatch-preserves-replacement')
    if ($summary.Count -ne 1 -or $cases.Count -ne $expectedNames.Count -or $values.Count -ne ($expectedNames.Count + 1)) { throw 'Native staging receipt shape differs.' }
    for ($index = 0; $index -lt $expectedNames.Count; $index++) {
        if ($cases[$index].name -ne $expectedNames[$index] -or $cases[$index].status -ne 'passed') { throw 'A required native staging case did not pass.' }
    }
    $result = $summary[0]
    if ($result.version -ne 1 -or $result.status -ne 'passed-staging-primitives-only' -or $result.counts.passed -ne $expectedNames.Count -or
        $result.counts.failed -ne 0 -or $result.counts.total -ne $expectedNames.Count -or $result.cleanupComplete -ne $true -or
        $result.positiveSignedProductionStageTested -ne $false -or $result.driverInstalled -ne $false -or $result.displayChanged -ne $false) { throw 'Native staging summary or cleanup differs.' }
    $record['cases'] = $cases; $record['summary'] = $result
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'Native staging validation changed committed source inputs.' }
    $record['status'] = 'passed-staging-primitives-only'
} catch {
    $record['status'] = 'failed'; $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $out 'package-staging-build.json') -Encoding utf8
}
