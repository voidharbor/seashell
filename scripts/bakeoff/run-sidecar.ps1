# Candidate C run: node.exe + node-pty with ten wsl.exe zsh panes (spec section 3).
# Proves the panes are live, idles 60 s, reports the tree's process count, then
# measures with measure-ram.ps1. Always stops the tree by its root pid.
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
Set-Location $root
New-Item -ItemType Directory -Force -Path "$root\bakeoff" | Out-Null
$out = "$root\bakeoff\C-sidecar.out"
$err = "$root\bakeoff\C-sidecar.err"
. "$root\scripts\win\app-tree.ps1"

function Read-Shared([string]$path) {
  # node holds the file open for writing; open it with ReadWrite sharing.
  if (-not (Test-Path $path)) { return '' }
  $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try { (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

$p = Start-Process -FilePath 'C:\seashell-build\node\node.exe' -ArgumentList 'scripts\bakeoff\sidecar-floor.mjs', '10' `
  -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
Write-Output "C-sidecar root pid $($p.Id)"
try {
  # The status line comes about 30 s after start.
  $status = $null
  for ($i = 0; $i -lt 60 -and -not $status; $i++) {
    Start-Sleep -Seconds 1
    $status = (Read-Shared $out) -split "`r?`n" | Where-Object { $_ -like '*"status":"panes"*' } | Select-Object -First 1
    if ($p.HasExited) { break }
  }
  Write-Output (Read-Shared $out)
  $e = Read-Shared $err
  if ($e) { Write-Output "stderr: $e" }
  if (-not $status) { throw 'no pane status line from sidecar-floor.mjs' }
  $live = ($status | ConvertFrom-Json).live
  if ($live -ne 10) { throw "only $live of 10 panes produced output" }

  # Spec section 2: 60 s idle after the last pane shows a prompt.
  Start-Sleep -Seconds 60

  $tree = @(Get-AppTree $p.Id)
  Write-Output "tree: $($tree.Count) processes"
  $tree | Group-Object Name | Sort-Object Name | ForEach-Object { Write-Output ("  {0} x{1}" -f $_.Name, $_.Count) }

  $global:LASTEXITCODE = 0
  & "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -Label C-sidecar
  $code = $LASTEXITCODE
  if ($code -eq 2) { Write-Output 'measure: not measured, Edge was open' }
  elseif ($code -ne 0) { Write-Output "measure: failed with exit $code" }
}
finally {
  & "$root\scripts\win\stop-tree.ps1" -RootPid $p.Id
}
