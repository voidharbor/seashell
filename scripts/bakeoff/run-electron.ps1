# Candidate A. Launches the release\win-unpacked Electron build in a scratch
# userData seeded with W10 (spec section 2), restores it over CDP, waits for
# every pane to show a prompt, idles 60 s, screenshots, measures, and always
# stops the tree by its root pid through stop-tree.ps1.
param([string]$Exe = 'C:\seashell-build\src\release\win-unpacked\SeaShell.exe', [int]$Port = 9340)
$ErrorActionPreference = 'Stop'
Set-Location C:\seashell-build\redesign
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
$bakeoff = 'C:\seashell-build\redesign\bakeoff'
$scratch = "$bakeoff\electron-scratch"
$shot = "$bakeoff\A-electron.png"
New-Item -ItemType Directory -Force -Path $bakeoff | Out-Null
if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch }
node C:\seashell-build\redesign\scripts\bakeoff\make-session.mjs $scratch /Users/joshwald
if ($LASTEXITCODE -ne 0) { throw "make-session failed ($LASTEXITCODE)" }
# W10: a 1440x900 window on the main display, not maximized (src/main/window-bounds.ts).
Set-Content -Path "$scratch\window-bounds.json" -Value '{"x":100,"y":100,"width":1440,"height":900,"maximized":false}' -Encoding Ascii

# One CDP call; returns stdout, or $null when the page is not reachable yet.
function Cdp([string[]]$CdpArgs) {
  try { $out = & node scripts\cdp.mjs $Port @CdpArgs 2>$null } catch { return $null }
  if ($LASTEXITCODE -ne 0) { return $null }
  return $out
}
function CdpInt([string]$Js) {
  $v = 0
  if ([int]::TryParse("$(Cdp @($Js))".Trim(), [ref]$v)) { return $v }
  return -1
}

# No double quotes inside these: PowerShell 5.1 mangles them on native argument lists.
$jsRestore = @'
(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Restore'); if (b) { b.click(); return 'clicked' } return 'no-card' })()
'@.Trim()
$jsPanes = 'window.__seashellTerminals ? window.__seashellTerminals.size : -1'
$jsPrompts = @'
(() => { const m = window.__seashellTerminals; if (!m) return -1; let n = 0; for (const t of m.values()) { const b = t.term.buffer.active; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) { n++; break } } } return n })()
'@.Trim()

$jsSkipTour = @'
(() => { const s = document.querySelector('.tut__skip'); if (s) { s.click(); return 'skipped' } return 'none' })()
'@.Trim()
$jsTourOpen = '!!document.querySelector(''.tut'')'

$env:SEASHELL_USER_DATA = $scratch
$p = Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port" -PassThru
Write-Output "root pid: $($p.Id)"
try {
  # The plan pressed Escape first; on the restore card Escape is Start fresh, so it is not sent.
  $clicked = $false
  for ($i = 0; $i -lt 60 -and -not $clicked; $i++) {
    Start-Sleep -Seconds 1
    $r = Cdp @($jsRestore)
    if ($r -and $r.Trim() -eq '"clicked"') { $clicked = $true }
  }
  Write-Output "restore: $(if ($clicked) { 'clicked' } else { 'card never appeared' })"
  if (-not $clicked) { throw 'restore card never appeared' }

  # Wait for all 10 panes to exist and to show a prompt (any text in the buffer).
  $n = -1; $prompts = -1
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    $n = CdpInt $jsPanes
    $prompts = CdpInt $jsPrompts
    if ($n -eq 10 -and $prompts -eq 10) { break }
  }
  Write-Output "panes: $n"
  Write-Output "prompts: $prompts"
  if ($n -ne 10 -or $prompts -ne 10) { throw "W10 not reached (panes $n, prompts $prompts); not measuring a partial workload" }

  # The first-run tutorial opens over the restored tabs (fresh userData); it is not part of W10.
  # Its Skip is a span (.tut__skip); a JS click does not depend on keyboard focus.
  $tour = Cdp @($jsSkipTour)
  Write-Output "tutorial: $tour"
  Start-Sleep -Seconds 1
  $still = Cdp @($jsTourOpen)
  if ($still -and $still.Trim() -eq 'true') { throw 'tutorial still open' }

  Start-Sleep -Seconds 60
  node scripts\cdp.mjs $Port --shot $shot
  & C:\seashell-build\redesign\scripts\win\measure-ram.ps1 -RootPid $p.Id -Label A-electron
  $code = $LASTEXITCODE
  if ($code -eq 2) { Write-Output 'measure: not measured, Edge was open' }
  elseif ($code -ne 0 -and $code -ne $null) { Write-Output "measure: exit $code" }
} finally {
  # By pid only: walks the tree so ConPTY hosts and wsl.exe relays go too.
  & C:\seashell-build\redesign\scripts\win\stop-tree.ps1 -RootPid $p.Id
}
