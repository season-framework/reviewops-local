# Future hosted read-only observation. No process is signalled or adopted.
# Input is built only from this fixture's retained CLI/child journal, never a
# process-name search or a user/port supplied PID. Start ticks remain strings.
param([Parameter(Mandatory=$true)][string]$InputManifest)
$ErrorActionPreference = 'Stop'
$records = Get-Content -LiteralPath $InputManifest -Raw | ConvertFrom-Json
if ($records.Count -gt 32) { throw 'Too many owned identities' }
$rows = @()
foreach ($record in $records) {
  if (($record.pid -isnot [int] -and $record.pid -isnot [long]) -or $record.pid -le 0 -or $record.pid -gt 2147483647 -or $record.startTicks -isnot [string] -or $record.startTicks -notmatch '^\d{15,20}$') {
    throw 'Invalid exact owned identity'
  }
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$record.pid)
  } catch {
    $cause = $_.Exception
    while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    # For a prevalidated positive PID, only ArgumentException denotes no
    # associated process. Access/platform/other errors are never cleanup proof.
    if ($cause -isnot [System.ArgumentException]) {
      throw 'Exact owned process lookup incomplete; not a cleanup confirmation'
    }
  }
  if ($null -eq $process) {
    $rows += [pscustomobject]@{ pid=$record.pid; requestedStartTicks=[string]$record.startTicks; originalRunning=$false; state='not-present' }
    continue
  }
  try {
    $ticks = $process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    $same = $ticks -eq [string]$record.startTicks
    $rows += [pscustomobject]@{ pid=$record.pid; requestedStartTicks=[string]$record.startTicks; observedStartTicks=$ticks; originalRunning=$same; state=$(if ($same) {'original-present'} else {'pid-reused-do-not-adopt'}) }
  } catch {
    throw 'Cannot verify exact owned process start identity; observation is incomplete'
  } finally {
    $process.Dispose()
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
