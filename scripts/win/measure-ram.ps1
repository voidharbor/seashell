# Measure the memory of one app tree at the W10 workload (spec section 2).
# Counts the root pid, every descendant by parent pid, and every
# msedgewebview2.exe whose command line contains -UdfSubstring. Refuses to
# sample while Microsoft Edge is running, because a shared runtime reads low.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$UdfSubstring = '',
  [Parameter(Mandatory = $true)][string]$Label,
  [int]$Samples = 5,
  [int]$GapSeconds = 10,
  [string]$ResultsFile = 'C:\seashell-build\redesign\bakeoff\results.jsonl'
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
  $taken += [pscustomobject]@{ wsMB = [math]::Round($ws, 1); privateMB = [math]::Round($priv, 1); processes = $procs.Count; top3 = $top3 }
}
function Median($xs) { $s = @($xs | Sort-Object); $n = $s.Count; if ($n % 2) { $s[[math]::Floor($n / 2)] } else { ($s[$n / 2 - 1] + $s[$n / 2]) / 2 } }
$row = [ordered]@{
  label = $Label; rootPid = $RootPid
  processes = [int](Median ($taken | ForEach-Object processes))
  wsMB = [double](Median ($taken | ForEach-Object wsMB))
  privateMB = [double](Median ($taken | ForEach-Object privateMB))
  samples = $taken; edgeRunning = $false; at = (Get-Date).ToString('o')
}
$json = ($row | ConvertTo-Json -Compress -Depth 5)
New-Item -ItemType Directory -Force -Path (Split-Path $ResultsFile) | Out-Null
Add-Content -Path $ResultsFile -Value $json
Write-Output $json
