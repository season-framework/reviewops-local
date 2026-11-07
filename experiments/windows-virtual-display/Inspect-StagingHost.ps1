# Read only the OS staging ancestors' security descriptors. Never alter them.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required.' }
$out = Join-Path $PSScriptRoot '_out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$source = (& git -C $PSScriptRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $source -notmatch '^[0-9a-f]{40}$' -or $env:GITHUB_SHA -ne $source -or
    $env:GITHUB_REPOSITORY -ne 'season-framework/reviewops-local' -or $env:GITHUB_REF -ne 'refs/heads/codex/windows-virtual-display-prototype' -or
    $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_RUN_ATTEMPT -ne '1') { throw 'Original diagnostic source/attempt binding differs.' }
$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if (-not [IO.Path]::IsPathFullyQualified($programData) -or $programData.Length -gt 140) { throw 'OS common application data path unavailable.' }
$paths = [Collections.Generic.List[string]]::new()
$current = [IO.DirectoryInfo]::new($programData)
while ($null -ne $current) { $paths.Insert(0, $current.FullName); $current = $current.Parent }
$record = [ordered]@{
    schema = 1; atUTC = [DateTime]::UtcNow.ToString('o'); source = $source
    producer = [ordered]@{ runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; event = $env:GITHUB_EVENT_NAME }
    scope = 'Read-only OS ProgramData ancestor ACL diagnostics, not staging or a passing test'
    directoryCreated = $false; aclChanged = $false; nativeTestsRun = $false; driverInstalled = $false
    ancestors = @()
}
foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path -Force
    $acl = Get-Acl -LiteralPath $path
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        [ordered]@{
            sid = $_.IdentityReference.Value
            type = $_.AccessControlType.ToString()
            rights = [int64]$_.FileSystemRights
            inheritance = $_.InheritanceFlags.ToString()
            propagation = $_.PropagationFlags.ToString()
            inherited = $_.IsInherited
        }
    })
    $record['ancestors'] += [ordered]@{
        path = $path; attributes = $item.Attributes.ToString()
        ownerSID = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        protectedDACL = $acl.AreAccessRulesProtected; sddl = $acl.Sddl; rules = $rules
    }
}
$record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out 'package-staging-host.json') -Encoding utf8
$record | ConvertTo-Json -Depth 10
