# Measure the memory of one app tree at the W10 workload (spec section 2).
# Counts the root pid, every descendant by parent pid, and every
# msedgewebview2.exe whose command line contains -UdfSubstring. Refuses to
# sample while Microsoft Edge is running, because a shared runtime reads low.
# -CorePid adds coreRssMB, the VmRSS of that Linux pid (the native shell's
# core under WSL, outside any Windows working set) from /proc/<pid>/status.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$UdfSubstring = '',
  [Parameter(Mandatory = $true)][string]$Label,
  [int]$Samples = 5,
  [int]$GapSeconds = 10,
  [string]$ResultsFile = 'C:\seashell-build\redesign\bakeoff\results.jsonl',
  [int]$CorePid = 0
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-tree.ps1"

function Assert-EdgeClosed {
  $edge = @(Get-Process -Name msedge -ErrorAction SilentlyContinue)
  if ($edge.Count -gt 0) {
    # Not Write-Error: under Stop it throws before the exit code is set.
    [Console]::Error.WriteLine("Microsoft Edge is running ($($edge.Count) msedge.exe processes); close it before measuring (spec 2). No sample taken.")
    exit 2
  }
}

# VmRSS of a Linux pid in MB, or $null when it cannot be read.
function Get-CoreRssMB([int]$LinuxPid) {
  # Continue, not Stop: Windows PowerShell turns a native command's stderr into a terminating error.
  $ErrorActionPreference = 'Continue'
  $status = & wsl.exe -d Ubuntu-24.04 -e cat "/proc/$LinuxPid/status" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $status) { return $null }
  $line = @($status | Where-Object { $_ -match '^VmRSS:\s+(\d+)\s+kB' })
  if ($line.Count -eq 0) { return $null }
  [void]($line[0] -match '^VmRSS:\s+(\d+)\s+kB')
  return [math]::Round([double]$Matches[1] / 1024, 1)
}

# Not $samples: variables are case-insensitive, that would be the [int]$Samples parameter.
$taken = @()
for ($i = 0; $i -lt $Samples; $i++) {
  if ($i -gt 0) { Start-Sleep -Seconds $GapSeconds }
  Assert-EdgeClosed
  $tree = Get-AppTree $RootPid $UdfSubstring
  $procs = @(Get-Process -Id @($tree | ForEach-Object { [int]$_.ProcessId }) -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { [Console]::Error.WriteLine("No live process in the tree of $RootPid. No sample taken."); exit 3 }
  $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  $priv = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
  $top3 = @($procs | Sort-Object WorkingSet64 -Descending | Select-Object -First 3 | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; wsMB = [math]::Round($_.WorkingSet64 / 1MB, 1) } })
  $sample = [ordered]@{ wsMB = [math]::Round($ws, 1); privateMB = [math]::Round($priv, 1); processes = $procs.Count; top3 = $top3; names = @($procs | Sort-Object Id | ForEach-Object ProcessName) }
  if ($CorePid -gt 0) {
    $rss = Get-CoreRssMB $CorePid
    if ($null -eq $rss) { [Console]::Error.WriteLine("Core pid $CorePid has no /proc status under WSL. No sample taken."); exit 5 }
    $sample.coreRssMB = $rss
  }
  $taken += [pscustomobject]$sample
}
function Median($xs) { $s = @($xs | Sort-Object); $n = $s.Count; if ($n % 2) { $s[[math]::Floor($n / 2)] } else { ($s[$n / 2 - 1] + $s[$n / 2]) / 2 } }
$row = [ordered]@{
  label = $Label; rootPid = $RootPid
  processes = [int](Median ($taken | ForEach-Object processes))
  wsMB = [double](Median ($taken | ForEach-Object wsMB))
  privateMB = [double](Median ($taken | ForEach-Object privateMB))
  samples = $taken; edgeRunning = $false; at = (Get-Date).ToString('o')
}
if ($CorePid -gt 0) {
  $row.corePid = $CorePid
  $row.coreRssMB = [double](Median ($taken | ForEach-Object coreRssMB))
}
$json = ($row | ConvertTo-Json -Compress -Depth 5)
New-Item -ItemType Directory -Force -Path (Split-Path $ResultsFile) | Out-Null
Add-Content -Path $ResultsFile -Value $json
Write-Output $json
