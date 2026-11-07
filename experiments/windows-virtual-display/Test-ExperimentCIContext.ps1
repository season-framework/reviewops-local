# Pure environment gate checks. No package, device, driver or display calls.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ExperimentCIContext.ps1')
$names = @('GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_SHA','GITHUB_RUN_ATTEMPT','REVIEWOPS_MANUAL_DISPLAY_PROBE')
$original = @{}
foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$source = 'a' * 40
$baseline = @{
    GITHUB_ACTIONS = 'true'; CI = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows'
    GITHUB_REPOSITORY = 'season-framework/reviewops-local'; GITHUB_REF = 'refs/heads/codex/windows-virtual-display-prototype'
    GITHUB_EVENT_NAME = 'push'; GITHUB_SHA = $source; GITHUB_RUN_ATTEMPT = '1'; REVIEWOPS_MANUAL_DISPLAY_PROBE = '0'
}
$checks = 0
function Check-Context([hashtable]$Context, [bool]$Allowed) {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $Context[$name], 'Process') }
    $accepted = $true
    try { Assert-DisplayExperimentCIContext -Source $source } catch { $accepted = $false }
    if ($accepted -ne $Allowed) { throw 'The experiment context gate accepted/refused an unexpected context.' }
    $script:checks++
}
try {
    Check-Context $baseline $true
    $manual = $baseline.Clone()
    $manual.GITHUB_REF = 'refs/heads/main'; $manual.GITHUB_EVENT_NAME = 'workflow_dispatch'; $manual.REVIEWOPS_MANUAL_DISPLAY_PROBE = '1'
    Check-Context $manual $true
    foreach ($name in $names) {
        $missing = $baseline.Clone(); $missing.Remove($name)
        # The manual marker is intentionally unnecessary on the original push.
        Check-Context $missing ($name -eq 'REVIEWOPS_MANUAL_DISPLAY_PROBE')
    }
    foreach ($patch in @(
        @{RUNNER_ENVIRONMENT='self-hosted'}, @{RUNNER_OS='Linux'}, @{GITHUB_REPOSITORY='other/repo'},
        @{GITHUB_REF='refs/heads/main'}, @{GITHUB_EVENT_NAME='pull_request'}, @{GITHUB_SHA=('b' * 40)}, @{GITHUB_RUN_ATTEMPT='2'}
    )) {
        $bad = $baseline.Clone(); foreach ($key in $patch.Keys) { $bad[$key] = $patch[$key] }; Check-Context $bad $false
    }
    foreach ($patch in @(
        @{REVIEWOPS_MANUAL_DISPLAY_PROBE='0'}, @{REVIEWOPS_MANUAL_DISPLAY_PROBE='true'},
        @{GITHUB_REF='refs/heads/unreviewed'}, @{GITHUB_EVENT_NAME='push'}, @{GITHUB_EVENT_NAME='pull_request'}
    )) {
        $bad = $manual.Clone(); foreach ($key in $patch.Keys) { $bad[$key] = $patch[$key] }; Check-Context $bad $false
    }
    [ordered]@{scope='Environment gate only'; passed=$checks; driverCalls=0; deviceCalls=0; displayCalls=0} | ConvertTo-Json -Compress
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
}
