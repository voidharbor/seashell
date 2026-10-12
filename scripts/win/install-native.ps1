# Install the native shell by a folder swap (Phase 3 plan Decision 1): move
# -Target aside to <Target>.electron-<stamp> (or .native-<stamp> when it is not
# the Electron build) and copy -Source in its place; with no folder at -Target
# yet, a fresh install just copies it in. -Rollback moves the newest backup
# back. Nothing touches shortcuts, the registry or %APPDATA%\seashell.
# -Source defaults to the folder this script sits in when that holds
# SeaShell.exe (the release zip's SeaShell\ folder), else <build tree>\release\win-native.
#
# Guards, in this order, each printing one line and exiting with its code:
#   2  -Target or -Source is not a plain drive-letter path (UNC, \\?\, \\.\ or a
#      stream), or -Target is the live install (%LOCALAPPDATA%\Programs\SeaShell)
#      and -Live was not given, or -Target is anywhere else under
#      %LOCALAPPDATA%\Programs. Compared both as written and as resolved through
#      junctions, symlinks and 8.3 names (read-only). Checked first, for every
#      mode, before anything is changed.
#   3  a process runs from -Target (by ExecutablePath through Win32_Process,
#      as written and resolved, never by name), or a SeaShell.exe has an
#      unreadable or unresolvable path (fail closed).
#   4  -Source lacks one of the seven release files, or lies inside -Target.
# Other exits: 5 nothing to do, a name is taken, or -Rollback finds two newest
# backups with the same stamp (nothing was changed), 6 a step failed and the
# previous state was restored, 7 a step failed and the restore failed too (the
# line names where everything is).
# -DryRun evaluates the guards, prints what it would do and changes nothing.
param(
  [string]$Source = '',
  [string]$Target = "$env:LOCALAPPDATA\Programs\SeaShell",
  [switch]$Live,
  [switch]$DryRun,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
if (-not $Source) {
  $Source = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'SeaShell.exe') -PathType Leaf) { $PSScriptRoot } else { Join-Path $PSScriptRoot '..\..\release\win-native' }
}

# Where a path really is: the deepest part that exists, opened with no access
# (CreateFileW, OPEN_EXISTING, never creating) and resolved through every
# junction, symlink and 8.3 name by GetFinalPathNameByHandleW, plus the part
# that does not exist yet. Null when an existing part cannot be opened.
if (-not ('SeaShellFinalPath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class SeaShellFinalPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFileAttributesW(string name);
  static string Final(string path, out int err) {
    err = 0;
    // access 0, share read/write/delete, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS
    using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) { err = Marshal.GetLastWin32Error(); return null; }
      StringBuilder sb = new StringBuilder(1024);
      uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
      if (n >= sb.Capacity) { sb = new StringBuilder((int)n + 1); n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); }
      if (n == 0 || n >= sb.Capacity) { err = -1; return null; }
      return sb.ToString();
    }
  }
  public static string Resolve(string path) {
    string cur = path;
    string rest = "";
    while (true) {
      int err;
      string f = Final(cur, out err);
      if (f != null) {
        if (f.StartsWith(@"\\?\UNC\")) f = @"\\" + f.Substring(8);
        else if (f.StartsWith(@"\\?\")) f = f.Substring(4);
        f = f.TrimEnd('\\');
        return rest.Length == 0 ? f : f + "\\" + rest;
      }
      // Only a part that is really absent is carried over; a dangling link,
      // a denied open or anything else fails closed.
      if (err != 2 && err != 3) return null;
      uint attrs = GetFileAttributesW(cur);
      int aerr = Marshal.GetLastWin32Error();
      if (attrs != 0xFFFFFFFF || (aerr != 2 && aerr != 3)) return null;
      string parent = Path.GetDirectoryName(cur);
      if (parent == null) return null;
      string leaf = Path.GetFileName(cur);
      rest = rest.Length == 0 ? leaf : leaf + "\\" + rest;
      cur = parent;
    }
  }
}
'@
}
# A plain drive-letter path (C:\...) with no UNC, \\?\ or \\.\ form and no
# stream colon, normalised by GetFullPath (strings only), or $null.
function Get-NormPath([string]$p) {
  try {
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).ProviderPath $p }
    if ($p -match '^[\\/]{2}') { return $null }
    $full = [IO.Path]::GetFullPath($p).TrimEnd('\')
  } catch { return $null }
  if ($full -match '^[A-Za-z]:\\[^:]+$') { return $full }
  return $null
}
function Resolve-Final([string]$p) {
  try { $f = [SeaShellFinalPath]::Resolve($p) } catch { return $null }
  if ($f -and $f -match '^[A-Za-z]:\\[^:]+$') { return $f }
  return $null
}
function Test-Under([string]$path, [string[]]$dirs) {
  foreach ($d in $dirs) { if ($path -ieq $d -or $path.StartsWith("$d\", [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}

# Guard (2).
if (-not $env:LOCALAPPDATA) { Write-Output 'install-native: refusing, LOCALAPPDATA is not set so the live install cannot be told apart'; exit 2 }
$livePath = Get-NormPath "$env:LOCALAPPDATA\Programs\SeaShell"
$programs = Get-NormPath "$env:LOCALAPPDATA\Programs"
$liveReal = if ($livePath) { Resolve-Final $livePath } else { $null }
$programsReal = if ($programs) { Resolve-Final $programs } else { $null }
if (-not $liveReal -or -not $programsReal) { Write-Output "install-native: refusing, $env:LOCALAPPDATA\Programs\SeaShell is not a plain drive-letter path that resolves, so the live install cannot be told apart"; exit 2 }
$given = $Target
$Target = Get-NormPath $Target
if (-not $Target) { Write-Output "install-native: refusing, -Target $given is not a plain drive-letter path (no UNC, \\?\, \\.\ or stream form)"; exit 2 }
$given = $Source
$Source = Get-NormPath $Source
if (-not $Source) { Write-Output "install-native: refusing, -Source $given is not a plain drive-letter path (no UNC, \\?\, \\.\ or stream form)"; exit 2 }
$targetReal = Resolve-Final $Target
if (-not $targetReal) { Write-Output "install-native: refusing, cannot resolve where $Target really is (a link that cannot be followed, or not a drive path)"; exit 2 }
$really = if ($targetReal -ine $Target) { " (really $targetReal)" } else { '' }
$isLive = $false
foreach ($t in @($Target, $targetReal)) {
  if ($t -ieq $livePath -or $t -ieq $liveReal -or $t -like '*\AppData\Local\Programs\SeaShell') { $isLive = $true }
}
if ($isLive -and -not $Live) {
  Write-Output "install-native: refusing, $Target$really is the live install and -Live was not given"
  exit 2
}
# Anything else in or under Programs is never a target, -Live or not.
if (-not $isLive -and ((Test-Under $Target @($programs, $programsReal)) -or (Test-Under $targetReal @($programs, $programsReal)) -or $Target -like '*\AppData\Local\Programs*' -or $targetReal -like '*\AppData\Local\Programs*')) {
  Write-Output "install-native: refusing, $Target$really is under $programs but is not the live install"
  exit 2
}

# Guard (3): any process whose image lies in the folder, by path as reported
# and as resolved (a process started through a junction or 8.3 name reports
# that name). A SeaShell.exe whose path cannot be read or resolved might be
# running from it, so that refuses too.
function Test-InUse([string]$dir, [string]$label) {
  $dirReal = Resolve-Final $dir
  if (-not $dirReal) { Write-Output "install-native: refusing, cannot resolve where $label really is"; exit 3 }
  $procs = @(Get-CimInstance Win32_Process)
  $exe = "$dir\SeaShell.exe"
  $blind = @()
  foreach ($p in $procs) {
    $path = $p.ExecutablePath
    if (-not $path) {
      if ($p.Name -ieq 'SeaShell.exe') { $blind += $p.ProcessId }
      continue
    }
    $pathReal = Resolve-Final $path
    if ($path -ieq $exe -or (Test-Under $path @($dir, $dirReal)) -or ($pathReal -and (Test-Under $pathReal @($dir, $dirReal)))) {
      $shown = if ($pathReal -and $pathReal -ine $path) { "$path (really $pathReal)" } else { $path }
      Write-Output "install-native: refusing, pid $($p.ProcessId) runs $shown from $label"
      exit 3
    }
    if (-not $pathReal -and $p.Name -ieq 'SeaShell.exe') { $blind += $p.ProcessId }
  }
  if ($blind.Count -gt 0) {
    Write-Output ("install-native: refusing, SeaShell.exe pid " + ($blind -join ',') + " has an unreadable or unresolvable path and may run from $label")
    exit 3
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
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
  # Stamps carry seconds (yyyyMMdd-HHmmss); an older minute stamp counts as :00.
  $pattern = '^' + [regex]::Escape($leaf) + '\.(electron|native)-(\d{8}-\d{4}(?:\d{2})?)$'
  $stampKey = { $s = [regex]::Match($_.Name, $pattern).Groups[2].Value; if ($s.Length -eq 13) { "${s}00" } else { $s } }
  $backups = @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } |
    Sort-Object $stampKey -Descending)
  if ($backups.Count -eq 0) { Write-Output "install-native: nothing to roll back to, no $leaf.electron-* or $leaf.native-* next to $Target"; exit 5 }
  if ($backups.Count -ge 2 -and ($backups[0] | ForEach-Object $stampKey) -eq ($backups[1] | ForEach-Object $stampKey)) {
    Write-Output "install-native: refusing, $($backups[0].Name) and $($backups[1].Name) have the same stamp so the newest is not known; nothing was changed"
    exit 5
  }
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

# Guard (4): the seven files pack-native.ps1 leaves in release\win-native.
$need = @('SeaShell.exe', 'utf8proc.dll', 'resources\core\index.cjs', 'resources\core\VERSION', 'resources\core\BUILD', 'resources\core\node\bin\node', 'resources\stage-core.sh')
foreach ($n in $need) {
  if (-not (Test-Path -LiteralPath "$Source\$n" -PathType Leaf)) { Write-Output "install-native: refusing, $Source lacks $n"; exit 4 }
}
if ($Source -ieq $Target -or $Source.StartsWith("$Target\", [StringComparison]::OrdinalIgnoreCase)) {
  Write-Output "install-native: refusing, $Source lies inside $Target"
  exit 4
}

# No folder there yet: a fresh install, nothing to back up.
$fresh = -not (Test-Path -LiteralPath $Target)
if (-not $fresh -and -not (Test-Path -LiteralPath $Target -PathType Container)) { Write-Output "install-native: refusing, $Target is a file, not a folder; nothing was changed"; exit 5 }
$backup = ''
if (-not $fresh) {
  $kind = if (Test-Path -LiteralPath "$Target\resources\app.asar") { 'electron' } else { 'native' }
  $backup = "$Target.$kind-$stamp"
  Assert-Free $backup
}
if ($DryRun) {
  if ($fresh) { Write-Output "would install $Source to $Target (new, nothing to back up)" }
  else { Write-Output "would install $Source over $Target (backup $backup)" }
  exit 0
}

if (-not $fresh) {
  try { Move-Item -LiteralPath $Target -Destination $backup }
  catch { Write-Output "install-native: failed moving $Target to $backup, nothing was changed: $($_.Exception.Message)"; exit 6 }
}

try {
  if ($fresh) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
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
  if ($fresh) { Write-Output "install-native: install failed, nothing was installed: $why"; exit 6 }
  try { Move-Item -LiteralPath $backup -Destination $Target }
  catch { Write-Output "install-native: install failed ($why) and moving $backup back failed too; the previous install is at $backup"; exit 7 }
  Write-Output "install-native: install failed, previous install restored at ${Target}: $why"
  exit 6
}

$short = if ($build.Length -ge 12) { $build.Substring(0, 12) } else { $build }
if ($fresh) {
  $uninstall = Join-Path $PSScriptRoot 'uninstall-native.ps1'
  Write-Output "installed $version $short at $Target; uninstall: powershell -ExecutionPolicy Bypass -File `"$uninstall`" -Target `"$Target`"$liveFlag"
  exit 0
}
Write-Output "installed $version $short; rollback: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Rollback -Target `"$Target`"$liveFlag"
exit 0
