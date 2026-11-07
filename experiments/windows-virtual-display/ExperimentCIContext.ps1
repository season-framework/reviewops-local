# Build/negative-test gate only. This script does not install, load or start a driver.
function Assert-DisplayExperimentCIContext {
    param([Parameter(Mandatory = $true)][string]$Source)
    $prototype = $env:GITHUB_EVENT_NAME -eq 'push' -and $env:GITHUB_REF -eq 'refs/heads/codex/windows-virtual-display-prototype'
    $manual = $env:GITHUB_EVENT_NAME -eq 'workflow_dispatch' -and $env:GITHUB_REF -eq 'refs/heads/main' -and $env:REVIEWOPS_MANUAL_DISPLAY_PROBE -eq '1'
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
        $env:GITHUB_REPOSITORY -ne 'season-framework/reviewops-local' -or -not ($prototype -or $manual) -or
        $Source -notmatch '^[0-9a-f]{40}$' -or $env:GITHUB_SHA -ne $Source -or $env:GITHUB_RUN_ATTEMPT -ne '1') {
        throw 'The original hosted CI source/attempt or explicit main dispatch binding differs.'
    }
}
