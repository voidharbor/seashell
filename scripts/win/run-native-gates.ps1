# The Phase 1 gates (plan Task 18) on a fresh scratch native shell. Launches
# release\win-native\SeaShell.exe for scratch\<Name> with the test driver on
# (the window never takes focus), runs scripts/native-gates.mjs under WSL's
# node against it, then quits through the driver and confirms the tree is
# gone. The restore gate seeds and launches its own scratch and the nesting
# gate launches a second shell from inside a pane; the mjs quits both through
# their drivers. Every stop is by pid (stop-tree.ps1), never by image name.
# Exit code: the mjs's (0 when every gate passed or was recorded as not
# verified, 1 when one failed).
param([string]$Name = 'gates', [string]$Gates = 'env,throughput,latency,nesting,control,restore')
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
Set-Location $root
$rel = "$root\release\win-native"
$exe = "$rel\SeaShell.exe"
$ud = "$root\scratch\$Name"
$out = "$root\bakeoff\gates-$Name.json"
. "$root\scripts\win\app-tree.ps1"

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

$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
if ($running.Count -gt 0) { throw "$exe is already running (pid $(($running | ForEach-Object ProcessId) -join ',')); stop that scratch first" }
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
New-Item -ItemType Directory -Force -Path $ud | Out-Null
# 1440x900 DIP at 100,100, as the W10 run; the shell saves physical pixels.
$dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
if (-not $dpi) { $dpi = 96 }
$w = [int][math]::Round(1440 * $dpi / 96); $h = [int][math]::Round(900 * $dpi / 96)
Set-Content -Path "$ud\window-bounds.json" -Value "{`"x`":100,`"y`":100,`"width`":$w,`"height`":$h,`"maximized`":false}" -Encoding Ascii

# Release layout: no SEASHELL_CORE_DIR, so the shell stages resources\core.
Remove-Item Env:SEASHELL_CORE_DIR -ErrorAction SilentlyContinue
$env:SEASHELL_USER_DATA = $ud
$env:SEASHELL_TEST_PORT = '0'
$env:SEASHELL_INSTANCE = $Name
$env:SEASHELL_SHELL_LOG = "$ud\shell.log"
$p = Start-Process -FilePath $exe -WorkingDirectory $rel -PassThru
Write-Output "shell pid $($p.Id) (window ${w}x${h} at $dpi dpi, scratch $ud)"
$tree = @()
$code = 1
try {
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path "$ud\test.json") -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path "$ud\test.json")) { throw 'no test.json in 30 s' }
  $r = Drive @{ cmd = 'wait'; path = '/panes/0/status'; equals = 'live'; timeoutMs = 60000 }
  if (-not $r.ok) { throw "the first pane never went live ($($r.code))" }
  $tree = @(Get-AppTree $p.Id)
  $tree | ForEach-Object { Write-Output ("tree: {0} {1} {2}" -f $_.ProcessId, $_.Name, $_.ExecutablePath) }
  $global:LASTEXITCODE = 0
  & wsl.exe -d Ubuntu-24.04 -e /usr/bin/node /mnt/c/seashell-build/redesign/scripts/native-gates.mjs $ud --shell-pid $p.Id --gates $Gates --out $out
  $code = $LASTEXITCODE
  Write-Output "gates: exit $code, numbers in $out"
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
exit $code
