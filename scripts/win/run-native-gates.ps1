# The Phase 1 gates (plan Task 18) and the Phase 2 gate (Task 20) on a fresh
# scratch native shell. Launches release\win-native\SeaShell.exe for
# scratch\<Name> with the test driver on (the window never takes focus), runs
# scripts/native-gates.mjs under WSL's node against it, then quits through the
# driver and confirms the tree is gone. The restore gate seeds and launches its
# own scratch and the nesting gate launches a second shell from inside a pane;
# the mjs quits both through their drivers. matrix and inventory run their own
# scripts with their own scratches. The main scratch is launched only when a
# gate needs it (env, throughput, latency, relay, nesting, control). w10a and
# w10b (not in the default list) run after it is gone, through
# run-native-w10.ps1, which measures alone; with Edge open they print "not
# measured, Edge was open" and launch nothing (their numbers go to
# bakeoff\gates-<Name>-w10.json). Every stop is by pid (stop-tree.ps1), never
# by image name.
# Exit code: the mjs's (0 when every gate passed or was recorded as not
# verified or not measured, 1 when one failed).
# -Gates takes a comma list as one string (-File) or as an array (-Command).
param([string]$Name = 'gates', [string[]]$Gates = @('env,throughput,latency,relay,nesting,control,restore,matrix,inventory'))
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
Set-Location $root
$rel = "$root\release\win-native"
$exe = "$rel\SeaShell.exe"
$ud = "$root\scratch\$Name"
$out = "$root\bakeoff\gates-$Name.json"
. "$root\scripts\win\app-tree.ps1"
$list = @($Gates | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$mainGates = @('env', 'throughput', 'latency', 'relay', 'nesting', 'control')
$needsMain = @($list | Where-Object { $mainGates -contains $_ }).Count -gt 0
$w10 = @($list | Where-Object { $_ -like 'w10*' })
$rest = @($list | Where-Object { $_ -notlike 'w10*' })

# One run of native-gates.mjs under WSL's node; its exit code lands in
# $script:gatesExit (the function's output is the mjs's lines, not a value).
$script:gatesExit = 0
function Invoke-Gates([string[]]$Which, [int]$ShellPid, [string]$OutFile) {
  $global:LASTEXITCODE = 0
  & wsl.exe -d Ubuntu-24.04 -e /usr/bin/node /mnt/c/seashell-build/redesign/scripts/native-gates.mjs $ud --shell-pid $ShellPid --gates ($Which -join ',') --out $OutFile
  $script:gatesExit = $LASTEXITCODE
  Write-Output "gates $($Which -join ','): exit $($script:gatesExit), numbers in $OutFile"
}

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

$code = 0
if ($needsMain) {
  $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
  if ($running.Count -gt 0) { throw "$exe is already running (pid $(($running | ForEach-Object ProcessId) -join ',')); stop that scratch first" }
  if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
  New-Item -ItemType Directory -Force -Path $ud | Out-Null
  # 1440x900 DIP at 100,100, as the W10 run; the shell saves physical pixels.
  $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
  if (-not $dpi) { $dpi = 96 }
  $w = [int][math]::Round(1440 * $dpi / 96); $h = [int][math]::Round(900 * $dpi / 96)
  Set-Content -Path "$ud\window-bounds.json" -Value "{`"x`":100,`"y`":100,`"width`":$w,`"height`":$h,`"maximized`":false}" -Encoding Ascii
  # The tutorial was seen (plan Task 14): no first-run sheet holds the keys or dims the window.
  Set-Content -Path "$ud\ui-state.json" -Value '{"tutorialSeen":true}' -Encoding Ascii

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
    Invoke-Gates $rest $p.Id $out
    $code = $script:gatesExit
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
} elseif ($rest.Count -gt 0) {
  # No gate here needs the main scratch: restore, matrix and inventory launch their own.
  Invoke-Gates $rest 0 $out
  $code = $script:gatesExit
}
if ($w10.Count -gt 0) {
  # After the main scratch is gone: run-native-w10.ps1 refuses while a release shell runs.
  Invoke-Gates $w10 0 "$root\bakeoff\gates-$Name-w10.json"
  if ($script:gatesExit -ne 0) { $code = $script:gatesExit }
}
exit $code
