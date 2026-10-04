# Uninstall the native shell that install-native.ps1 put at -Target. When its
# INSTALLED.json names a backup that still exists, this is a rollback to that
# backup (the current folder goes to <Target>.rolledback-<stamp>). Otherwise the
# folder is moved to <Target>.removed-<stamp> and that is deleted. A folder that
# holds resources\app.asar is the Electron build, not a native install, and is
# refused. Nothing touches shortcuts, the registry or %APPDATA%\seashell.
#
# Guards and exits as install-native.ps1: 2 the live install without -Live (or
# anything else under %LOCALAPPDATA%\Programs), checked first; 3 a process runs
# from the folder (by path, never by name) or a SeaShell.exe has an unreadable
# path; 5 nothing to do, nothing was changed; 6 a step failed and the previous
# state was restored; 7 a step failed and so did the restore.
param(
  [string]$Target = "$env:LOCALAPPDATA\Programs\SeaShell",
  [switch]$Live
)
$ErrorActionPreference = 'Stop'

# Guard (2). Strings only: GetFullPath does not touch the folder.
function Get-NormPath([string]$p) {
  if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).ProviderPath $p }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}
if (-not $env:LOCALAPPDATA) { Write-Output 'uninstall-native: refusing, LOCALAPPDATA is not set so the live install cannot be told apart'; exit 2 }
$livePath = Get-NormPath "$env:LOCALAPPDATA\Programs\SeaShell"
$programs = Get-NormPath "$env:LOCALAPPDATA\Programs"
$Target = Get-NormPath $Target
$isLive = ($Target -ieq $livePath) -or ($Target -like '*\AppData\Local\Programs\SeaShell')
if ($isLive -and -not $Live) {
  Write-Output "uninstall-native: refusing, $Target is the live install and -Live was not given"
  exit 2
}
if (-not $isLive -and ($Target -ieq $programs -or $Target.StartsWith("$programs\", [StringComparison]::OrdinalIgnoreCase) -or $Target -like '*\AppData\Local\Programs*')) {
  Write-Output "uninstall-native: refusing, $Target is under $programs but is not the live install"
  exit 2
}

# Guard (3), as install-native.ps1.
function Test-InUse([string]$dir) {
  $procs = @(Get-CimInstance Win32_Process)
  $exe = "$dir\SeaShell.exe"
  foreach ($p in $procs) {
    if (-not $p.ExecutablePath) { continue }
    $path = $p.ExecutablePath
    if ($path -ieq $exe -or $path.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase)) {
      Write-Output "uninstall-native: refusing, pid $($p.ProcessId) runs $path from $dir"
      exit 3
    }
  }
  $blind = @($procs | Where-Object { -not $_.ExecutablePath -and $_.Name -ieq 'SeaShell.exe' })
  if ($blind.Count -gt 0) {
    Write-Output ("uninstall-native: refusing, SeaShell.exe pid " + (($blind | ForEach-Object ProcessId) -join ',') + " has an unreadable path and may run from $dir")
    exit 3
  }
}
Test-InUse $Target

if (-not (Test-Path -LiteralPath $Target -PathType Container)) { Write-Output "uninstall-native: nothing at $Target"; exit 5 }
if (Test-Path -LiteralPath "$Target\resources\app.asar") { Write-Output "uninstall-native: refusing, $Target is the Electron build, not a native install; nothing was changed"; exit 5 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$leaf = Split-Path -Leaf $Target
$backup = ''
$infoPath = "$Target\INSTALLED.json"
if (Test-Path -LiteralPath $infoPath) {
  try { $named = [string](([IO.File]::ReadAllText($infoPath) | ConvertFrom-Json).backup) }
  catch { Write-Output "uninstall-native: refusing, $infoPath does not parse; nothing was changed"; exit 5 }
  if ($named) { $named = Get-NormPath $named }
  if ($named -and (Test-Path -LiteralPath $named -PathType Container)) {
    # Only a backup install-native.ps1 could have made: a sibling named <leaf>.electron-<stamp> or <leaf>.native-<stamp>.
    $pattern = '^' + [regex]::Escape($leaf) + '\.(electron|native)-\d{8}-\d{4}$'
    if (-not ((Split-Path -Parent $named) -ieq (Split-Path -Parent $Target)) -or -not ((Split-Path -Leaf $named) -match $pattern)) {
      Write-Output "uninstall-native: refusing, $infoPath names $named, which is not a backup next to $Target; nothing was changed"
      exit 5
    }
    $backup = $named
  }
}

if ($backup) {
  Test-InUse $backup
  $aside = "$Target.rolledback-$stamp"
  if (Test-Path -LiteralPath $aside) { Write-Output "uninstall-native: refusing, $aside already exists; nothing was changed"; exit 5 }
  try { Move-Item -LiteralPath $Target -Destination $aside }
  catch { Write-Output "uninstall-native: failed moving $Target aside, nothing was changed: $($_.Exception.Message)"; exit 6 }
  try { Move-Item -LiteralPath $backup -Destination $Target }
  catch {
    $why = $_.Exception.Message
    try { Move-Item -LiteralPath $aside -Destination $Target }
    catch { Write-Output "uninstall-native: rollback failed ($why) and so did putting $aside back; the backup is $backup"; exit 7 }
    Write-Output "uninstall-native: rollback failed moving $backup into place, $Target is as it was: $why"
    exit 6
  }
  Write-Output "rolled back to $backup"
  exit 0
}

$removed = "$Target.removed-$stamp"
if (Test-Path -LiteralPath $removed) { Write-Output "uninstall-native: refusing, $removed already exists; nothing was changed"; exit 5 }
try { Move-Item -LiteralPath $Target -Destination $removed }
catch { Write-Output "uninstall-native: failed moving $Target aside, nothing was changed: $($_.Exception.Message)"; exit 6 }
try { Remove-Item -LiteralPath $removed -Recurse -Force }
catch { Write-Output "uninstall-native: removed $Target, but deleting $removed failed: $($_.Exception.Message)"; exit 7 }
Write-Output "removed $Target"
exit 0
