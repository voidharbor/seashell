# Install the native shell by a folder swap (Phase 3 plan Decision 1): move
# -Target aside to <Target>.electron-<stamp> (or .native-<stamp> when it is not
# the Electron build) and copy -Source in its place. -Rollback moves the newest
# backup back. Nothing touches shortcuts, the registry or %APPDATA%\seashell.
#
# Guards, in this order, each printing one line and exiting with its code:
#   2  -Target is the live install (%LOCALAPPDATA%\Programs\SeaShell) and -Live
#      was not given, or -Target is anywhere else under %LOCALAPPDATA%\Programs.
#      Checked first, for every mode, before anything is read.
#   3  a process runs from -Target (by ExecutablePath through Win32_Process,
#      never by name), or a SeaShell.exe has an unreadable path (fail closed).
#   4  -Source lacks one of the six release files, or lies inside -Target.
# Other exits: 5 nothing to do or a name is taken (nothing was changed),
# 6 a step failed and the previous state was restored, 7 a step failed and the
# restore failed too (the line names where everything is).
# -DryRun evaluates the guards, prints what it would do and changes nothing.
param(
  [string]$Source = 'C:\seashell-build\redesign\release\win-native',
  [string]$Target = "$env:LOCALAPPDATA\Programs\SeaShell",
  [switch]$Live,
  [switch]$DryRun,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'

# Guard (2). Strings only: GetFullPath does not touch the folder.
function Get-NormPath([string]$p) {
  if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).ProviderPath $p }
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}
if (-not $env:LOCALAPPDATA) { Write-Output 'install-native: refusing, LOCALAPPDATA is not set so the live install cannot be told apart'; exit 2 }
$livePath = Get-NormPath "$env:LOCALAPPDATA\Programs\SeaShell"
$programs = Get-NormPath "$env:LOCALAPPDATA\Programs"
$Target = Get-NormPath $Target
$isLive = ($Target -ieq $livePath) -or ($Target -like '*\AppData\Local\Programs\SeaShell')
if ($isLive -and -not $Live) {
  Write-Output "install-native: refusing, $Target is the live install and -Live was not given"
  exit 2
}
# Anything else in or under Programs is never a target, -Live or not.
if (-not $isLive -and ($Target -ieq $programs -or $Target.StartsWith("$programs\", [StringComparison]::OrdinalIgnoreCase) -or $Target -like '*\AppData\Local\Programs*')) {
  Write-Output "install-native: refusing, $Target is under $programs but is not the live install"
  exit 2
}
$Source = Get-NormPath $Source

# Guard (3): any process whose image lies in the folder, by path. A SeaShell.exe
# whose path cannot be read might be running from it, so that refuses too.
function Test-InUse([string]$dir, [string]$label) {
  $procs = @(Get-CimInstance Win32_Process)
  $exe = "$dir\SeaShell.exe"
  foreach ($p in $procs) {
    if (-not $p.ExecutablePath) { continue }
    $path = $p.ExecutablePath
    if ($path -ieq $exe -or $path.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase)) {
      Write-Output "install-native: refusing, pid $($p.ProcessId) runs $path from $label"
      exit 3
    }
  }
  $blind = @($procs | Where-Object { -not $_.ExecutablePath -and $_.Name -ieq 'SeaShell.exe' })
  if ($blind.Count -gt 0) {
    Write-Output ("install-native: refusing, SeaShell.exe pid " + (($blind | ForEach-Object ProcessId) -join ',') + " has an unreadable path and may run from $label")
    exit 3
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$parent = Split-Path -Parent $Target
$leaf = Split-Path -Leaf $Target
$liveFlag = if ($isLive) { ' -Live' } else { '' }

# Move-Item onto an existing folder would nest inside it, so every new name is checked first.
function Assert-Free([string]$path) {
  if (Test-Path -LiteralPath $path) { Write-Output "install-native: refusing, $path already exists; nothing was changed"; exit 5 }
}

if ($Rollback) {
  Test-InUse $Target $Target
  # Newest by the stamp in the name: a moved folder keeps its old timestamps.
  $pattern = '^' + [regex]::Escape($leaf) + '\.(electron|native)-(\d{8}-\d{4})$'
  $backups = @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } |
    Sort-Object { [regex]::Match($_.Name, $pattern).Groups[2].Value } -Descending)
  if ($backups.Count -eq 0) { Write-Output "install-native: nothing to roll back to, no $leaf.electron-* or $leaf.native-* next to $Target"; exit 5 }
  $backup = $backups[0].FullName
  Test-InUse $backup $backup
  $aside = "$Target.rolledback-$stamp"
  $hasTarget = Test-Path -LiteralPath $Target
  if ($hasTarget) { Assert-Free $aside }
  if ($DryRun) {
    $what = if ($hasTarget) { "(current moved to $aside)" } else { '(no current folder)' }
    Write-Output "would roll back $Target to $backup $what"
    exit 0
  }
  if ($hasTarget) {
    try { Move-Item -LiteralPath $Target -Destination $aside }
    catch { Write-Output "install-native: rollback failed moving $Target aside, nothing was changed: $($_.Exception.Message)"; exit 6 }
  }
  try { Move-Item -LiteralPath $backup -Destination $Target }
  catch {
    $why = $_.Exception.Message
    if ($hasTarget) {
      try { Move-Item -LiteralPath $aside -Destination $Target }
      catch { Write-Output "install-native: rollback failed ($why) and so did putting $aside back; the backup is $backup"; exit 7 }
    }
    Write-Output "install-native: rollback failed moving $backup into place, $Target is as it was: $why"
    exit 6
  }
  Write-Output "rolled back to $backup"
  exit 0
}

Test-InUse $Target $Target

# Guard (4): the six files pack-native.ps1 leaves in release\win-native.
$need = @('SeaShell.exe', 'utf8proc.dll', 'resources\core\index.cjs', 'resources\core\VERSION', 'resources\core\BUILD', 'resources\stage-core.sh')
foreach ($n in $need) {
  if (-not (Test-Path -LiteralPath "$Source\$n" -PathType Leaf)) { Write-Output "install-native: refusing, $Source lacks $n"; exit 4 }
}
if ($Source -ieq $Target -or $Source.StartsWith("$Target\", [StringComparison]::OrdinalIgnoreCase)) {
  Write-Output "install-native: refusing, $Source lies inside $Target"
  exit 4
}

if (-not (Test-Path -LiteralPath $Target -PathType Container)) { Write-Output "install-native: refusing, there is no folder at $Target to back up; nothing was changed"; exit 5 }
$kind = if (Test-Path -LiteralPath "$Target\resources\app.asar") { 'electron' } else { 'native' }
$backup = "$Target.$kind-$stamp"
Assert-Free $backup
if ($DryRun) {
  Write-Output "would install $Source over $Target (backup $backup)"
  exit 0
}

try { Move-Item -LiteralPath $Target -Destination $backup }
catch { Write-Output "install-native: failed moving $Target to $backup, nothing was changed: $($_.Exception.Message)"; exit 6 }

try {
  Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
  $want = (Get-FileHash -Algorithm SHA256 -LiteralPath "$Source\SeaShell.exe").Hash
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath "$Target\SeaShell.exe").Hash
  if ($want -ne $got) { throw "SeaShell.exe sha256 $got after the copy, expected $want" }
  $srcCount = @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File).Count
  $dstCount = @(Get-ChildItem -LiteralPath $Target -Recurse -Force -File).Count
  if ($srcCount -ne $dstCount) { throw "$dstCount files after the copy, expected $srcCount" }
  $version = ([IO.File]::ReadAllText("$Target\resources\core\VERSION")).Trim()
  $build = ([IO.File]::ReadAllText("$Target\resources\core\BUILD")).Trim()
  $info = [ordered]@{ version = $version; build = $build; source = $Source; backup = $backup; installedAt = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText("$Target\INSTALLED.json", ($info | ConvertTo-Json) + "`n", (New-Object Text.UTF8Encoding($false)))
}
catch {
  $why = $_.Exception.Message
  # Antivirus may hold a freshly copied file for a moment, so the removal retries.
  for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $Target); $i++) {
    try { Remove-Item -LiteralPath $Target -Recurse -Force } catch { Start-Sleep -Seconds 1 }
  }
  if (Test-Path -LiteralPath $Target) { Write-Output "install-native: install failed ($why) and the partial $Target could not be removed; the previous install is at $backup"; exit 7 }
  try { Move-Item -LiteralPath $backup -Destination $Target }
  catch { Write-Output "install-native: install failed ($why) and moving $backup back failed too; the previous install is at $backup"; exit 7 }
  Write-Output "install-native: install failed, previous install restored at ${Target}: $why"
  exit 6
}

$short = if ($build.Length -ge 12) { $build.Substring(0, 12) } else { $build }
Write-Output "installed $version $short; rollback: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Rollback -Target `"$Target`"$liveFlag"
exit 0
