# Uninstall the native shell that install-native.ps1 put at -Target. When its
# INSTALLED.json names a backup that still exists, this is a rollback to that
# backup (the current folder goes to <Target>.rolledback-<stamp>). Otherwise the
# folder is moved to <Target>.removed-<stamp> and that is deleted. Only a native
# install is touched: $Target\SeaShell.exe with resources\core\VERSION, or an
# INSTALLED.json; anything else (the Electron build with resources\app.asar
# included) is refused. Nothing touches shortcuts, the registry or
# %APPDATA%\seashell.
#
# Guards and exits as install-native.ps1: 2 -Target is not a plain drive-letter
# path, or is the live install without -Live (or anything else under
# %LOCALAPPDATA%\Programs), as written and as resolved through junctions,
# symlinks and 8.3 names, checked first; 3 a process runs from the folder (by
# path as reported and resolved, never by name) or a SeaShell.exe has an
# unreadable or unresolvable path; 5 nothing to do or not a native install,
# nothing was changed; 6 a step failed and the previous state was restored;
# 7 a step failed and so did the restore.
# -DryRun evaluates the guards, prints what it would do and changes nothing.
param(
  [string]$Target = "$env:LOCALAPPDATA\Programs\SeaShell",
  [switch]$Live,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

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
if (-not $env:LOCALAPPDATA) { Write-Output 'uninstall-native: refusing, LOCALAPPDATA is not set so the live install cannot be told apart'; exit 2 }
$livePath = Get-NormPath "$env:LOCALAPPDATA\Programs\SeaShell"
$programs = Get-NormPath "$env:LOCALAPPDATA\Programs"
$liveReal = if ($livePath) { Resolve-Final $livePath } else { $null }
$programsReal = if ($programs) { Resolve-Final $programs } else { $null }
if (-not $liveReal -or -not $programsReal) { Write-Output "uninstall-native: refusing, $env:LOCALAPPDATA\Programs\SeaShell is not a plain drive-letter path that resolves, so the live install cannot be told apart"; exit 2 }
$given = $Target
$Target = Get-NormPath $Target
if (-not $Target) { Write-Output "uninstall-native: refusing, -Target $given is not a plain drive-letter path (no UNC, \\?\, \\.\ or stream form)"; exit 2 }
$targetReal = Resolve-Final $Target
if (-not $targetReal) { Write-Output "uninstall-native: refusing, cannot resolve where $Target really is (a link that cannot be followed, or not a drive path)"; exit 2 }
$really = if ($targetReal -ine $Target) { " (really $targetReal)" } else { '' }
$isLive = $false
foreach ($t in @($Target, $targetReal)) {
  if ($t -ieq $livePath -or $t -ieq $liveReal -or $t -like '*\AppData\Local\Programs\SeaShell') { $isLive = $true }
}
if ($isLive -and -not $Live) {
  Write-Output "uninstall-native: refusing, $Target$really is the live install and -Live was not given"
  exit 2
}
if (-not $isLive -and ((Test-Under $Target @($programs, $programsReal)) -or (Test-Under $targetReal @($programs, $programsReal)) -or $Target -like '*\AppData\Local\Programs*' -or $targetReal -like '*\AppData\Local\Programs*')) {
  Write-Output "uninstall-native: refusing, $Target$really is under $programs but is not the live install"
  exit 2
}

# Guard (3), as install-native.ps1.
function Test-InUse([string]$dir) {
  $dirReal = Resolve-Final $dir
  if (-not $dirReal) { Write-Output "uninstall-native: refusing, cannot resolve where $dir really is"; exit 3 }
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
      Write-Output "uninstall-native: refusing, pid $($p.ProcessId) runs $shown from $dir"
      exit 3
    }
    if (-not $pathReal -and $p.Name -ieq 'SeaShell.exe') { $blind += $p.ProcessId }
  }
  if ($blind.Count -gt 0) {
    Write-Output ("uninstall-native: refusing, SeaShell.exe pid " + ($blind -join ',') + " has an unreadable or unresolvable path and may run from $dir")
    exit 3
  }
}
Test-InUse $Target

if (-not (Test-Path -LiteralPath $Target -PathType Container)) { Write-Output "uninstall-native: nothing at $Target"; exit 5 }
if (Test-Path -LiteralPath "$Target\resources\app.asar") { Write-Output "uninstall-native: refusing, $Target is the Electron build, not a native install; nothing was changed"; exit 5 }
$native = ((Test-Path -LiteralPath "$Target\SeaShell.exe" -PathType Leaf) -and (Test-Path -LiteralPath "$Target\resources\core\VERSION" -PathType Leaf)) -or (Test-Path -LiteralPath "$Target\INSTALLED.json" -PathType Leaf)
if (-not $native) { Write-Output "uninstall-native: refusing, $Target is not a native install (no SeaShell.exe with resources\core\VERSION, no INSTALLED.json); nothing was changed"; exit 5 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$leaf = Split-Path -Leaf $Target
$backup = ''
$infoPath = "$Target\INSTALLED.json"
if (Test-Path -LiteralPath $infoPath) {
  try { $named = [string](([IO.File]::ReadAllText($infoPath) | ConvertFrom-Json).backup) }
  catch { Write-Output "uninstall-native: refusing, $infoPath does not parse; nothing was changed"; exit 5 }
  if ($named) {
    $raw = $named
    $named = Get-NormPath $named
    if (-not $named) { Write-Output "uninstall-native: refusing, $infoPath names $raw, which is not a plain drive-letter path; nothing was changed"; exit 5 }
  }
  if ($named -and (Test-Path -LiteralPath $named -PathType Container)) {
    # Only a backup install-native.ps1 could have made: a sibling named <leaf>.electron-<stamp> or <leaf>.native-<stamp>.
    $pattern = '^' + [regex]::Escape($leaf) + '\.(electron|native)-\d{8}-\d{4}(\d{2})?$'
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
  if ($DryRun) { Write-Output "would roll back $Target to $backup (current moved to $aside)"; exit 0 }
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
if ($DryRun) { Write-Output "would remove $Target (moved to $removed, then deleted)"; exit 0 }
try { Move-Item -LiteralPath $Target -Destination $removed }
catch { Write-Output "uninstall-native: failed moving $Target aside, nothing was changed: $($_.Exception.Message)"; exit 6 }
try { Remove-Item -LiteralPath $removed -Recurse -Force }
catch { Write-Output "uninstall-native: removed $Target, but deleting $removed failed: $($_.Exception.Message)"; exit 7 }
Write-Output "removed $Target"
exit 0
