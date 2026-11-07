# Compile original-file-owned control; test private protocol/I/O units without a driver or real device control.
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
    scope = 'Owned display-control component units only; no actual driver/device/control activation'
    driverRebuilt = $false; driverInstalled = $false; driverExecuted = $false
    certificateImported = $false; bootSecurityChanged = $false; fullProductQA = $false
    positiveSignedProductionInstallTested = $false; positiveInstalledControlTested = $false
    acceptedCoreSource = '7de4e5a25a00cb4ff39a03a3b87e994ac78d26bd'
    acceptedCoreRunId = 42346727348
    unchangedAdmissionAndStagingCasesRepeated = $false; unchangedInstallerDeviceCasesRepeated = $false; actualNativeDeviceControlExecuted = $false
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
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the owned-control component inputs before building.' }
    $record['inputs'] = @()
    foreach ($name in @('ControlProtocol.h', 'PackageAdmission.h', 'PackageAdmission.cpp', 'PackageStaging.h', 'PackageStaging.cpp', 'PackageInstall.h', 'PackageInstall.cpp', 'OwnedSoftwareDevice.h', 'OwnedSoftwareDevice.cpp', 'OwnedDisplayControl.h', 'OwnedDisplayControl.cpp', 'OwnedDisplayControlTests.cpp',
                       'ReviewOpsOwnedControl.vcxproj', 'ReviewOpsOwnedControlTests.vcxproj', 'Directory.Build.props', 'packages.config')) {
        $path = Join-Path $root $name
        $record['inputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    # Reuse only the exact accepted core source, including Windows CRLF checkouts.
    $acceptedCoreInputs = @{
        'ControlProtocol.h' = @('ead898bb938a7964c14a71e41a59df887f1c53176af41f3fd601dadf4f14dceb', '001f5cb6b7773bbb3dc4384a58f5a81e10f1d34a9651037157fc47b095cb29dd')
        'PackageAdmission.h' = @('c34452a3cefc48b52d796ae74b597c3042ecd8e182b830cfac4515ac856df88d', '3420cf4e0438014d0fe87a381a550b04f356cbdbdfb972524ad1c8dc958bd2be')
        'PackageAdmission.cpp' = @('7501e9002115864e447a91bdbddc25fc9b621edc158ba19ece53cf3e046dbc0e', '82d30d53ca853b67696322ff202f6ac8869599cb26464b9926f097037835a62d')
        'PackageStaging.h' = @('6e0485248c9b8a1e58389db67822b972ab942ebd36f8a72266ca3f7ded2b25d8', '6aa008f25f50e1c09a073979a6b3529ac94e4406ae5565d289fa18461c1eb401')
        'PackageStaging.cpp' = @('c6c8268668344ee91c83fb7f572405a634b9dbeb25ba13fe572e47ba4c49b146', '1d0d38d5de333633185c7779034705fa8aa9efd646b9aec427694392d4130c53')
        'PackageInstall.h' = @('93b313028a40df6c24e45572ee9be939340ef97a65eacff5d9bcc87be8de1508', 'f6f4fd8fd7c19684e9700adf304521580e2fc395051d35526fe3bcc58ef32959')
        'PackageInstall.cpp' = @('1ca9b890781047d0a39e363dcd34c2444c88f28d5781095fb1a6863de8d43159', '61ccf265874656fde5da18c3822570a422ce8bbf88f5f0fdba2155c093a14937')
        'OwnedSoftwareDevice.h' = @('08f439f63036a760ecead9a837ee79c7c8c031951467fe92e7a1e853a24c3502', 'a7a27f27da2435f41871216f9e923742dfead67dea5fa0f5d3b72d2e15bb1e8a')
        'OwnedSoftwareDevice.cpp' = @('4e563d91bd5dae769e3727aabc84f6b614f51db78d1fccd026718caa5f9ac232', '6352781cf1d831cd98d9dd48aca835710145b584465f0d64eb9d894e07329d87')
    }
    foreach ($name in $acceptedCoreInputs.Keys) {
        $actual = @($record['inputs'] | Where-Object { $_.name -eq $name })
        if ($actual.Count -ne 1 -or $actual[0].sha256 -notin $acceptedCoreInputs[$name]) { throw 'Changed accepted core requires its own affected native evidence.' }
    }
    $record['acceptedCoreInputsMatched'] = $true
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
        Tee-Object -FilePath (Join-Path $out 'owned-control-components-restore.log')
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
    foreach ($project in @('ReviewOpsOwnedControl', 'ReviewOpsOwnedControlTests')) {
        & $msbuild (Join-Path $root ($project + '.vcxproj')) /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" 2>&1 |
            Tee-Object -FilePath (Join-Path $out ('owned-control-components-' + $project + '-msbuild.log'))
        if ($LASTEXITCODE -ne 0) { throw 'Native owned-control component compilation failed.' }
    }
    $record['outputs'] = @()
    foreach ($name in @('ReviewOpsOwnedControl.lib', 'ReviewOpsOwnedControlTests.exe')) {
        $path = Join-Path $out ('owned-control\' + $name)
        $record['outputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $binary = Join-Path $out 'owned-control\ReviewOpsOwnedControlTests.exe'
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $binary
    $info.ArgumentList.Add('--self-test')
    $info.WorkingDirectory = Join-Path $out 'owned-control'
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
        if (-not $process.Start()) { throw 'The native control component tests did not start.' }
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
        [IO.File]::WriteAllText((Join-Path $out 'owned-control-components-tests-stdout.log'), $invocation['stdout'], [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $out 'owned-control-components-tests-stderr.log'), $invocation['stderr'], [Text.UTF8Encoding]::new($false))
        $process.Dispose()
    }
    Write-Host 'COMMAND ReviewOpsOwnedControlTests.exe --self-test'
    Write-Host $invocation['stdout']
    if ($invocation['stderr']) { Write-Host $invocation['stderr'] }
    if (-not $invocation['exitConfirmed'] -or -not $invocation['streamsDrained'] -or $invocation['terminationRequested'] -or $invocation['exitCode'] -ne 0 -or $invocation['stderr']) { throw 'Native control component tests did not finish successfully.' }
    $lines = @($invocation['stdout'] -split '\r?\n' | Where-Object { $_.Trim() })
    $values = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    $cases = @($values | Where-Object { $_.type -eq 'case' })
    $summary = @($values | Where-Object { $_.type -eq 'summary' })
    $expectedNames = @(
        'reply-header-binding-refusals',
        'reply-monitor-shape-refusals',
        'initial-monitor-adoption-refused',
        'pinned-file-and-monitor-tuples',
        'create-remove-receipts',
        'sticky-uncertainty-no-rearm',
        'io-confirmed-reply',
        'io-short-reply-refused',
        'io-timeout-drained-no-adoption',
        'io-unconfirmed-retains-memory',
        'close-scope-and-a-b-slot-isolation',
        'public-capability-admission-refusals'
    )
    if ($summary.Count -ne 1 -or $cases.Count -ne $expectedNames.Count -or $values.Count -ne ($expectedNames.Count + 1)) { throw 'Native control component receipt shape differs.' }
    for ($index = 0; $index -lt $expectedNames.Count; $index++) {
        if ($cases[$index].name -ne $expectedNames[$index] -or $cases[$index].status -ne 'passed') { throw 'A required native control component case did not pass.' }
    }
    $result = $summary[0]
    if ($result.version -ne 1 -or $result.status -ne 'passed-owned-control-units-only' -or $result.counts.passed -ne $expectedNames.Count -or
        $result.counts.failed -ne 0 -or $result.counts.total -ne $expectedNames.Count -or $result.cleanupComplete -ne $true -or
        $result.positiveInstalledControlTested -ne $false -or $result.actualSoftwareDevicesCreated -ne 0 -or $result.actualMonitorsCreated -ne 0 -or
        $result.driverInstalled -ne $false -or $result.displayChanged -ne $false -or $result.actualDeviceIoControlCalls -ne 0) { throw 'Native control component summary or cleanup differs.' }
    $record['cases'] = $cases; $record['summary'] = $result
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'Native control component validation changed committed source inputs.' }
    $record['status'] = 'passed-owned-control-units-only'
} catch {
    $record['status'] = 'failed'; $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $out 'owned-control-components-build.json') -Encoding utf8
}
