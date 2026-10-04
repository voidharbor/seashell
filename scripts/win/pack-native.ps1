# Assemble release\win-native (spec 4.5): the shell, its DLLs, stage-core.sh
# and resources\core (the bundle, VERSION, BUILD and the Linux node-pty). The
# bundle and node-pty come from the worktree over \\wsl.localhost, because the
# build tree's node_modules is the Windows install and out\ is never synced.
# Refuses while release\win-native\SeaShell.exe runs (checked by path), so a
# scratch instance is never overwritten under itself.
# -Zip also writes release\SeaShell-<VERSION>-win-native.zip: a top-level
# SeaShell\ folder holding release\win-native plus install-native.ps1 and
# uninstall-native.ps1. The zip is the future release asset; nothing uploads it.
param(
  [string]$Worktree = '\\wsl.localhost\Ubuntu-24.04\Users\joshwald\seashell-wt\redesign',
  [string]$Root = 'C:\seashell-build\redesign',
  [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$dst = "$Root\release\win-native"
$exe = "$dst\SeaShell.exe"

$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
if ($running.Count -gt 0) {
  [Console]::Error.WriteLine("pack-native: refusing, $exe is running (pid " + (($running | ForEach-Object ProcessId) -join ',') + ')')
  exit 4
}

$built = "$Root\shell-build\Release"
$bundle = "$Worktree\out\core"
$pty = "$Worktree\node_modules\node-pty"
foreach ($need in @("$built\SeaShell.exe", "$bundle\index.cjs", "$bundle\VERSION", "$pty\package.json", "$pty\build\Release\pty.node", "$Root\scripts\win\stage-core.sh")) {
  if (-not (Test-Path $need)) { [Console]::Error.WriteLine("pack-native: missing $need"); exit 3 }
}
# Checked before anything is written, so a -Zip without the scripts packs nothing.
$scripts = @("$Root\scripts\win\install-native.ps1", "$Root\scripts\win\uninstall-native.ps1")
if ($Zip) {
  foreach ($need in $scripts) {
    if (-not (Test-Path $need)) { [Console]::Error.WriteLine("pack-native: -Zip needs $need, which is missing; nothing was packed"); exit 5 }
  }
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force "$built\SeaShell.exe" $exe
Get-ChildItem -Path $built -Filter *.dll | ForEach-Object { Copy-Item -Force $_.FullName "$dst\$($_.Name)" }

$res = "$dst\resources"
$core = "$res\core"
if (Test-Path $core) { Remove-Item -Recurse -Force $core }
New-Item -ItemType Directory -Force -Path "$core\node_modules\node-pty\build\Release" | Out-Null
Copy-Item -Force "$Root\scripts\win\stage-core.sh" "$res\stage-core.sh"
Copy-Item -Force "$bundle\index.cjs" "$core\index.cjs"
Copy-Item -Force "$bundle\VERSION" "$core\VERSION"
Copy-Item -Force "$pty\package.json" "$core\node_modules\node-pty\package.json"
Copy-Item -Recurse -Force "$pty\lib" "$core\node_modules\node-pty\lib"
Copy-Item -Force "$pty\build\Release\pty.node" "$core\node_modules\node-pty\build\Release\pty.node"
if (Test-Path "$pty\build\Release\spawn-helper") {
  Copy-Item -Force "$pty\build\Release\spawn-helper" "$core\node_modules\node-pty\build\Release\spawn-helper"
}
# stage-core.sh re-copies when BUILD differs: the version stays while the bundle changes.
$hash = (Get-FileHash -Algorithm SHA256 "$core\index.cjs").Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$core\BUILD", "$hash`n")

$version = ([IO.File]::ReadAllText("$core\VERSION")).Trim()
$files = @(Get-ChildItem -Recurse -File $dst)
$mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Output "packed $dst (core $version, build $($hash.Substring(0, 12)), $($files.Count) files, $mb MB)"

if ($Zip) {
  $stageRoot = "$Root\release\zip-stage"
  $stage = "$stageRoot\SeaShell"
  $zipPath = "$Root\release\SeaShell-$version-win-native.zip"
  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -Recurse -Force "$dst\*" $stage
  foreach ($s in $scripts) { Copy-Item -Force $s $stage }
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  # The folder itself as the path, so the zip's one top-level entry is SeaShell\.
  Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal
  Remove-Item -Recurse -Force $stageRoot
  $zmb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
  Write-Output "zipped $zipPath ($zmb MB)"
}
