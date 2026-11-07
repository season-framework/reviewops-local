# Fetch only the exact original fixture; the token is scoped to this workflow step.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'season-framework/reviewops-local') { throw 'The repository Windows CI host is required.' }
if (-not $env:GH_TOKEN) { throw 'The read-only Actions token is unavailable.' }
$out = Join-Path $PSScriptRoot '_out'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$archive = Join-Path $out 'admission-baseline-original.zip'
$destination = Join-Path $out 'admission-baseline'
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $destination)) { throw 'The original fixture must not be overwritten.' }
try {
    Invoke-WebRequest -Uri 'https://api.github.com/repos/season-framework/reviewops-local/actions/artifacts/13560775754/zip' -Headers @{
        Authorization = "Bearer $($env:GH_TOKEN)"
        Accept = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    } -OutFile $archive -TimeoutSec 45
} catch { throw 'The exact original Actions fixture could not be downloaded.' }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne 'a0c7e8c1cd0c96047eb430356d78a2c6c3d29fcd6428872b5bdee8c2b4876da8' -or (Get-Item -LiteralPath $archive).Length -ne 102440) { throw 'The original fixture archive identity differs.' }
Expand-Archive -LiteralPath $archive -DestinationPath $destination
$producer = Get-Content -LiteralPath (Join-Path $destination 'build-report.json') -Raw | ConvertFrom-Json
if ($producer.source -ne '884e87504c5b56133e46bbeb65cae6d441baa1ba' -or $producer.producer.runId -ne '42338440488' -or $producer.producer.runAttempt -ne '1' -or $producer.unsignedDriverPackage.catalogSignature -ne 'NotSigned') { throw 'The fixture producer does not match the accepted unsigned package.' }
$package = Join-Path $destination 'unsigned-driver-package'
if (@(Get-ChildItem -LiteralPath $package -Force).Count -ne 3 -or $producer.unsignedDriverPackage.files.Count -ne 3) { throw 'The original fixture layout differs.' }
foreach ($entry in $producer.unsignedDriverPackage.files) {
    if ($entry.name -notin @('reviewopsvirtualdisplay.cat', 'ReviewOpsVirtualDisplay.inf', 'ReviewOpsVirtualDisplay.dll')) { throw 'Unexpected fixture member.' }
    $path = Join-Path $package $entry.name
    if ((Get-Item -LiteralPath $path).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'An original fixture member differs.' }
}
[ordered]@{
    schema = 1; artifactId = 13560775754; archiveSHA256 = $hash; source = $producer.source
    runId = 42338440488; runAttempt = 1; catalogSignature = 'NotSigned'
    scope = 'Original immutable fixture for negative admission cases; never installed'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'admission-baseline-source.json') -Encoding utf8
Write-Output 'Verified the original unsigned INF/DLL/CAT fixture from run 42338440488.'
