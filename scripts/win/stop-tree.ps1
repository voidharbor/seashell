# Stop one scratch app tree by pid: the root, then every descendant still alive.
# Never by image name. Refuses outright if any process in the tree runs from
# Programs\SeaShell (Josh's installed app), so a wrong pid can never reach it.
param([Parameter(Mandatory = $true)][int]$RootPid, [string]$UdfSubstring = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-tree.ps1"
$tree = @(Get-AppTree $RootPid $UdfSubstring)
if ($tree.Count -eq 0) { Write-Output "stop-tree: $RootPid is not running"; exit 0 }
foreach ($p in $tree) {
  if ($p.ExecutablePath -and $p.ExecutablePath -like '*\Programs\SeaShell\*') {
    [Console]::Error.WriteLine("stop-tree: refusing, pid $($p.ProcessId) runs $($p.ExecutablePath)")
    exit 4
  }
}
Stop-Process -Id $RootPid -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$stopped = @($RootPid)
foreach ($p in $tree) {
  if ([int]$p.ProcessId -eq $RootPid) { continue }
  $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)" -ErrorAction SilentlyContinue
  if ($live -and $live.CreationDate -eq $p.CreationDate) {
    Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $stopped += [int]$p.ProcessId
  }
}
Write-Output ("stop-tree: root $RootPid, tree of $($tree.Count), stopped " + ($stopped -join ','))
