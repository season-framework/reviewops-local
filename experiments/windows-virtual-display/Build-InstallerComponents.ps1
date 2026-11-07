# Compile installer/device source; exercise metadata, read-only roots and scripted callbacks only.
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
    scope = 'Installer/device component units: metadata and scripted callbacks plus native read-only OS roots; no production installation'
    driverRebuilt = $false; driverInstalled = $false; driverExecuted = $false
    certificateImported = $false; bootSecurityChanged = $false; fullProductQA = $false
    positiveSignedProductionInstallTested = $false
    acceptedCoreSource = '33df958907b72e6adac049607e6483f3caef5ca5'
    acceptedCoreRunId = 42343734537
    unchangedAdmissionAndStagingCasesRepeated = $false
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
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the installer/device component inputs before building.' }
    $record['inputs'] = @()
    foreach ($name in @('ControlProtocol.h', 'PackageAdmission.h', 'PackageAdmission.cpp', 'PackageStaging.h', 'PackageStaging.cpp', 'PackageInstall.h', 'PackageInstall.cpp', 'OwnedSoftwareDevice.h', 'OwnedSoftwareDevice.cpp', 'InstallerComponentTests.cpp',
                       'ReviewOpsOwnedDevice.vcxproj', 'ReviewOpsOwnedDeviceTests.vcxproj', 'Directory.Build.props', 'packages.config')) {
        $path = Join-Path $root $name
        $record['inputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    # Reuse only the exact accepted core source, including Windows CRLF checkouts.
    $acceptedCoreInputs = @{
        'PackageAdmission.h' = @('c34452a3cefc48b52d796ae74b597c3042ecd8e182b830cfac4515ac856df88d', '3420cf4e0438014d0fe87a381a550b04f356cbdbdfb972524ad1c8dc958bd2be')
        'PackageAdmission.cpp' = @('7501e9002115864e447a91bdbddc25fc9b621edc158ba19ece53cf3e046dbc0e', '82d30d53ca853b67696322ff202f6ac8869599cb26464b9926f097037835a62d')
        'PackageStaging.h' = @('6e0485248c9b8a1e58389db67822b972ab942ebd36f8a72266ca3f7ded2b25d8', '6aa008f25f50e1c09a073979a6b3529ac94e4406ae5565d289fa18461c1eb401')
        'PackageStaging.cpp' = @('c6c8268668344ee91c83fb7f572405a634b9dbeb25ba13fe572e47ba4c49b146', '1d0d38d5de333633185c7779034705fa8aa9efd646b9aec427694392d4130c53')
    }
    foreach ($name in $acceptedCoreInputs.Keys) {
        $actual = @($record['inputs'] | Where-Object { $_.name -eq $name })
        if ($actual.Count -ne 1 -or $actual[0].sha256 -notin $acceptedCoreInputs[$name]) { throw 'Changed admission/staging core requires its own accepted native evidence.' }
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
        Tee-Object -FilePath (Join-Path $out 'owned-device-components-restore.log')
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
    foreach ($project in @('ReviewOpsOwnedDevice', 'ReviewOpsOwnedDeviceTests')) {
        & $msbuild (Join-Path $root ($project + '.vcxproj')) /t:Build /m:1 /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:VCToolsVersion=$vcVersion" 2>&1 |
            Tee-Object -FilePath (Join-Path $out ('owned-device-components-' + $project + '-msbuild.log'))
        if ($LASTEXITCODE -ne 0) { throw 'Native installer/device component compilation failed.' }
    }
    $record['outputs'] = @()
    foreach ($name in @('ReviewOpsOwnedDevice.lib', 'ReviewOpsOwnedDeviceTests.exe')) {
        $path = Join-Path $out ('owned-device\' + $name)
        $record['outputs'] += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $binary = Join-Path $out 'owned-device\ReviewOpsOwnedDeviceTests.exe'
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $binary
    $info.ArgumentList.Add('--self-test')
    $info.WorkingDirectory = Join-Path $out 'owned-device'
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
        if (-not $process.Start()) { throw 'The native installer component tests did not start.' }
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
        [IO.File]::WriteAllText((Join-Path $out 'owned-device-components-tests-stdout.log'), $invocation['stdout'], [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $out 'owned-device-components-tests-stderr.log'), $invocation['stderr'], [Text.UTF8Encoding]::new($false))
        $process.Dispose()
    }
    Write-Host 'COMMAND ReviewOpsOwnedDeviceTests.exe --self-test'
    Write-Host $invocation['stdout']
    if ($invocation['stderr']) { Write-Host $invocation['stderr'] }
    if (-not $invocation['exitConfirmed'] -or -not $invocation['streamsDrained'] -or $invocation['terminationRequested'] -or $invocation['exitCode'] -ne 0 -or $invocation['stderr']) { throw 'Native installer component tests did not finish successfully.' }
    $lines = @($invocation['stdout'] -split '\r?\n' | Where-Object { $_.Trim() })
    $values = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    $cases = @($values | Where-Object { $_.type -eq 'case' })
    $summary = @($values | Where-Object { $_.type -eq 'summary' })
    $expectedNames = @(
        'import-output-classification',
        'import-output-refusals',
        'native-system-roots-readonly',
        'callback-before-create-return',
        'callback-after-create-return',
        'callback-failure-closes-owner',
        'create-failure-no-replay',
        'timeout-drains-late-callback',
        'callback-handle-mismatch-refused',
        'callback-id-bounds-refused',
        'persistent-lifetime-refused',
        'owner-close-isolation'
    )
    if ($summary.Count -ne 1 -or $cases.Count -ne $expectedNames.Count -or $values.Count -ne ($expectedNames.Count + 1)) { throw 'Native installer component receipt shape differs.' }
    for ($index = 0; $index -lt $expectedNames.Count; $index++) {
        if ($cases[$index].name -ne $expectedNames[$index] -or $cases[$index].status -ne 'passed') { throw 'A required native installer component case did not pass.' }
    }
    $result = $summary[0]
    if ($result.version -ne 1 -or $result.status -ne 'passed-installer-component-units-only' -or $result.counts.passed -ne $expectedNames.Count -or
        $result.counts.failed -ne 0 -or $result.counts.total -ne $expectedNames.Count -or $result.cleanupComplete -ne $true -or
        $result.positiveSignedProductionInstallTested -ne $false -or $result.actualSetupCopyCalls -ne 0 -or $result.actualSoftwareDevicesCreated -ne 0 -or $result.driverInstalled -ne $false -or $result.displayChanged -ne $false) { throw 'Native installer component summary or cleanup differs.' }
    $record['cases'] = $cases; $record['summary'] = $result
    $dirtyAfter = (& git -C $root status --porcelain --untracked-files=all -- . | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirtyAfter) { throw 'Native installer component validation changed committed source inputs.' }
    $record['status'] = 'passed-installer-component-units-only'
} catch {
    $record['status'] = 'failed'; $record['error'] = $_.Exception.Message
    throw
} finally {
    $record['completedAtUTC'] = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $out 'owned-device-components-build.json') -Encoding utf8
}
