# Dot-sourced by measure-ram.ps1 and stop-tree.ps1. Walks one app tree: the
# root pid and every descendant by parent pid. A child counts only if it was
# created after its parent, so a recycled parent pid never pulls in an
# unrelated process. -UdfSubstring adds every msedgewebview2.exe whose command
# line names the app's WebView2 user data folder.
function Get-AppTree([int]$RootPid, [string]$UdfSubstring = '') {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath, CreationDate)
  $byPid = @{}
  $byParent = @{}
  foreach ($p in $all) {
    $byPid[[int]$p.ProcessId] = $p
    if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId] = @() }
    $byParent[[int]$p.ParentProcessId] += $p
  }
  $set = New-Object System.Collections.Generic.HashSet[int]
  if (-not $byPid.ContainsKey($RootPid)) { return @() }
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    if (-not $set.Add($cur)) { continue }
    if ($byParent.ContainsKey($cur)) {
      foreach ($c in $byParent[$cur]) {
        if ($c.CreationDate -ge $byPid[$cur].CreationDate) { $queue.Enqueue([int]$c.ProcessId) }
      }
    }
  }
  if ($UdfSubstring) {
    foreach ($p in $all) {
      if ($p.Name -eq 'msedgewebview2.exe' -and $p.CommandLine -and $p.CommandLine.Contains($UdfSubstring)) { [void]$set.Add([int]$p.ProcessId) }
    }
  }
  return @($set | ForEach-Object { $byPid[$_] })
}
