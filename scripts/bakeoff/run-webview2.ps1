# Bake-off candidate B (spec section 3): launch the WebView2 renderer floor,
# wait for the live zsh prompt in terminal 0 plus 60 s idle (W10, spec section 2),
# check ten terminals, take a screenshot, measure, and always stop the tree.
param([int]$Port = 9341)
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
Set-Location $root
$page = "$root\native\bakeoff\webview2\page"
$exe = "$root\bakeoff\b-build\Release\bakeoff-webview2.exe"
Copy-Item "$root\node_modules\@xterm\xterm\lib\xterm.js" $page -Force
Copy-Item "$root\node_modules\@xterm\xterm\css\xterm.css" $page -Force
Copy-Item "$root\node_modules\@xterm\addon-webgl\lib\addon-webgl.js" $page -Force
$udf = "$root\bakeoff\webview2-udf"
if (Test-Path $udf) { Remove-Item -Recurse -Force $udf }
if (Test-Path "$udf.log") { Remove-Item -Force "$udf.log" }
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
# Windows PowerShell turns a native command's stderr into a terminating error
# under Stop, so node runs with Continue; the exit code is checked instead.
function Invoke-Cdp { $ErrorActionPreference = 'Continue'; & node scripts\cdp.mjs $Port @args 2>&1 | ForEach-Object { "$_" } }
$p = Start-Process -FilePath $exe -ArgumentList "$page", "$udf" -PassThru
Write-Output "root pid: $($p.Id)"
try {
  # The DevTools endpoint and the page.
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Seconds 1
    if ($p.HasExited) { throw "bakeoff-webview2.exe exited early with code $($p.ExitCode)" }
    try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/json"; $up = $true } catch { }
  }
  if (-not $up) { throw "no DevTools endpoint on port $Port after 60 s" }
  # The live prompt in terminal 0.
  $text = ''
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $text = @(Invoke-Cdp "window.__bakeoffText0 ? window.__bakeoffText0().length : 0")[-1]
    if ($LASTEXITCODE -eq 0 -and $text -match '^\d+$' -and [int]$text -gt 0) { break }
  }
  Write-Output "terminal 0 chars after startup: $text"
  if (-not ($text -match '^\d+$' -and [int]$text -gt 0)) { throw 'no prompt in terminal 0 after 60 s; not measuring a partial W10' }
  Write-Output 'idle 60 s after the prompt (W10)'
  Start-Sleep -Seconds 60
  $count = Invoke-Cdp "window.__bakeoffTerms.length"
  Write-Output "terminals: $count"
  $gl = Invoke-Cdp "window.__bakeoffWebgl.filter(Boolean).length"
  Write-Output "webgl addons loaded: $gl"
  $t0 = Invoke-Cdp "window.__bakeoffText0()"
  Write-Output "terminal 0 text: $t0"
  # Spec 2: never record a partial workload.
  if ("$(@($count)[-1])" -ne '10' -or "$(@($gl)[-1])" -ne '10') { throw "workload short: terminals $count, webgl $gl" }
  Invoke-Cdp --shot "$root\bakeoff\B-webview2.png"
  & "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -UdfSubstring 'webview2-udf' -Label B-webview2
  $code = $LASTEXITCODE
  if ($code -eq 2) { Write-Output 'measure: not measured, Edge was open' }
  elseif ($code -ne 0) { Write-Output "measure: exit $code" }
} finally {
  # Walks the tree by pid, including the msedgewebview2.exe processes of this udf.
  & "$root\scripts\win\stop-tree.ps1" -RootPid $p.Id -UdfSubstring 'webview2-udf'
  if (Test-Path "$udf.log") { Write-Output "host log:"; Get-Content "$udf.log" }
}
