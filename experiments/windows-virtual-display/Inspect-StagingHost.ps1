# Read only the OS staging ancestors' security descriptors. Never alter them.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required.' }
$out = Join-Path $PSScriptRoot '_out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$source = (& git -C $PSScriptRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Source identity unavailable.' }
. (Join-Path $PSScriptRoot 'ExperimentCIContext.ps1')
Assert-DisplayExperimentCIContext -Source $source
if (-not [Environment]::Is64BitProcess) { throw 'Native x64 folder lookup is required.' }
$folders = [ordered]@{
    ProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    ProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
}
$paths = [Collections.Generic.List[string]]::new()
foreach ($path in $folders.Values) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or $path.Length -gt 140) { throw 'An OS known folder is unavailable.' }
    $current = [IO.DirectoryInfo]::new($path)
    while ($null -ne $current) {
        if (-not $paths.Contains($current.FullName)) { $paths.Insert(0, $current.FullName) }
        $current = $current.Parent
    }
}
$record = [ordered]@{
    schema = 1; atUTC = [DateTime]::UtcNow.ToString('o'); source = $source
    producer = [ordered]@{ runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; event = $env:GITHUB_EVENT_NAME }
    scope = 'Read-only OS ProgramData and x64 ProgramFiles ancestor ACL diagnostics, not staging or a passing test'
    folders = $folders; nativeX64Process = $true
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
