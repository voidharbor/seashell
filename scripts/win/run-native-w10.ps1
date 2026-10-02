# The native shell at W10 (redesign spec section 2). Seeds scratch\w10-native
# with make-session.mjs (WSL's node), launches release\win-native\SeaShell.exe
# without SEASHELL_CORE_DIR (so the core is staged), restores through the test
# driver, waits for 9 tabs, 10 panes and a prompt in every pane's grid, idles
# 60 s, shoots bakeoff\E-native.png, measures the tree plus the core's RSS,
# then quits through the driver and confirms the tree is gone. Every stop is
# by pid (stop-tree.ps1), never by image name.
param([string]$Name = 'w10-native', [string]$Label = 'E-native')
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$rel = "$root\release\win-native"
$exe = "$rel\SeaShell.exe"
$ud = "$root\scratch\$Name"
$shot = "$root\bakeoff\$Label.png"
. "$root\scripts\win\app-tree.ps1"

# One driver request over the loopback port in test.json; returns the parsed reply.
function Drive([hashtable]$Req) {
  $t = [IO.File]::ReadAllText("$ud\test.json") | ConvertFrom-Json
  $Req.token = $t.token
  $line = ($Req | ConvertTo-Json -Compress -Depth 6) + "`n"
  $wait = if ($Req.ContainsKey('timeoutMs')) { [int]$Req.timeoutMs } else { 0 }
  $c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', [int]$t.port)
  try {
    $c.ReceiveTimeout = $wait + 20000
    $s = $c.GetStream()
    $b = [Text.Encoding]::UTF8.GetBytes($line)
    $s.Write($b, 0, $b.Length)
    $reply = (New-Object IO.StreamReader($s, [Text.Encoding]::UTF8)).ReadLine()
  } finally { $c.Close() }
  if (-not $reply) { throw "driver $($Req.cmd): no reply" }
  return ($reply | ConvertFrom-Json)
}
function Model { $m = Drive @{ cmd = 'model' }; if ($m.ok -eq $false) { throw "driver model: $($m.code)" }; return $m }

$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
if ($running.Count -gt 0) { throw "$exe is already running (pid $(($running | ForEach-Object ProcessId) -join ',')); stop that scratch first" }
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
New-Item -ItemType Directory -Force -Path $ud | Out-Null
$udLinux = '/mnt/c/' + $ud.Substring(3).Replace('\', '/')
& wsl.exe -d Ubuntu-24.04 -e /usr/bin/node /mnt/c/seashell-build/redesign/scripts/bakeoff/make-session.mjs $udLinux /Users/joshwald
if ($LASTEXITCODE -ne 0) { throw "make-session failed ($LASTEXITCODE)" }
# W10: 1440x900 on the main display, not maximized. The native shell saves
# physical pixels (PerMonitorV2), so the size is scaled by the system DPI.
$dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
if (-not $dpi) { $dpi = 96 }
$w = [int][math]::Round(1440 * $dpi / 96); $h = [int][math]::Round(900 * $dpi / 96)
Set-Content -Path "$ud\window-bounds.json" -Value "{`"x`":100,`"y`":100,`"width`":$w,`"height`":$h,`"maximized`":false}" -Encoding Ascii

# Release layout: no SEASHELL_CORE_DIR, so the shell stages resources\core.
Remove-Item Env:SEASHELL_CORE_DIR -ErrorAction SilentlyContinue
$env:SEASHELL_USER_DATA = $ud
$env:SEASHELL_TEST_PORT = '0'
$env:SEASHELL_INSTANCE = 'w10'
$env:SEASHELL_SHELL_LOG = "$ud\shell.log"
$p = Start-Process -FilePath $exe -WorkingDirectory $rel -PassThru
Write-Output "shell pid $($p.Id) (window ${w}x${h} at $dpi dpi)"
$tree = @()
try {
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path "$ud\test.json") -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path "$ud\test.json")) { throw 'no test.json in 30 s' }
  $r = Drive @{ cmd = 'wait'; path = '/restore/tabs'; timeoutMs = 90000 }
  if (-not $r.ok) { throw "the restore card never appeared ($($r.code))" }
  Write-Output "restore card: $($r.value) tabs"
  [void](Drive @{ cmd = 'click'; target = 'restore:yes' })
  $r = Drive @{ cmd = 'wait'; path = '/tabs/8/id'; timeoutMs = 60000 }
  if (-not $r.ok) { throw 'nine tabs never appeared' }
  $tabs = @((Model).tabs)
  if ($tabs.Count -ne 9) { throw "$($tabs.Count) tabs, not 9; not measuring a partial workload" }

  # The model lists the active tab's panes, so each tab is selected in turn.
  $paneIds = @()
  for ($i = 0; $i -lt $tabs.Count; $i++) {
    [void](Drive @{ cmd = 'click'; target = "tab:$($tabs[$i].id)" })
    $r = Drive @{ cmd = 'wait'; path = "/tabs/$i/active"; equals = $true; timeoutMs = 10000 }
    if (-not $r.ok) { throw "tab $($i + 1) never became active" }
    $want = if ($i -eq 0) { 2 } else { 1 }
    $deadline = (Get-Date).AddSeconds(30)
    do { $panes = @((Model).panes); if ($panes.Count -lt $want) { Start-Sleep -Milliseconds 200 } } while ($panes.Count -lt $want -and (Get-Date) -lt $deadline)
    foreach ($pane in $panes) {
      $g = Drive @{ cmd = 'waitText'; paneId = $pane.id; contains = '%'; timeoutMs = 90000 }
      if (-not $g.ok) { throw "no prompt in pane $($pane.id) of tab $($i + 1)" }
      $paneIds += $pane.id
    }
  }
  [void](Drive @{ cmd = 'click'; target = "tab:$($tabs[0].id)" })
  [void](Drive @{ cmd = 'wait'; path = '/tabs/0/active'; equals = $true; timeoutMs = 10000 })
  Write-Output "tabs: $($tabs.Count)"
  Write-Output "panes: $($paneIds.Count)"
  if ($paneIds.Count -ne 10) { throw "$($paneIds.Count) panes, not 10; not measuring a partial workload" }
  Write-Output 'prompts: 10; idling 60 s (W10)'
  Start-Sleep -Seconds 60
  if ($p.HasExited) { throw "the shell exited with code $($p.ExitCode)" }

  $s = Drive @{ cmd = 'shot'; path = $shot }
  Write-Output "shot: $(if ($s.ok) { $shot } else { "failed $($s.code)" })"
  $ctl = [IO.File]::ReadAllText("$ud\control.json") | ConvertFrom-Json
  $corePid = [int]$ctl.corePid
  Write-Output "core pid (Linux) $corePid"
  $tree = @(Get-AppTree $p.Id)
  $tree | ForEach-Object { Write-Output ("tree: {0} {1} {2}" -f $_.ProcessId, $_.Name, $_.ExecutablePath) }
  $global:LASTEXITCODE = 0
  & "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -Label $Label -CorePid $corePid
  $code = $LASTEXITCODE
  if ($code -eq 2) { Write-Output 'measure: not measured, Edge was open' }
  elseif ($code -ne 0) { Write-Output "measure: failed with exit $code" }
} finally {
  if (-not $p.HasExited) {
    if (-not $tree) { $tree = @(Get-AppTree $p.Id) }
    try { [void](Drive @{ cmd = 'quit' }) } catch { Write-Output "driver quit failed: $($_.Exception.Message)" }
    [void]$p.WaitForExit(15000)
  }
  Start-Sleep -Seconds 3
  $left = @($tree | Where-Object {
      $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)" -ErrorAction SilentlyContinue
      $live -and $live.CreationDate -eq $_.CreationDate })
  if ($p.HasExited -and $left.Count -eq 0) {
    Write-Output "quit: the tree is gone (shell exit $($p.ExitCode))"
  } else {
    Write-Output "quit: $($left.Count) of $($tree.Count) tree processes left; stopping by pid"
    & "$root\scripts\win\stop-tree.ps1" -RootPid $p.Id
    foreach ($q in $left) { if ([int]$q.ProcessId -ne $p.Id) { Stop-Process -Id $q.ProcessId -ErrorAction SilentlyContinue } }
  }
}
