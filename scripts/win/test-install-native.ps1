# Exercise install-native.ps1 (Phase 3 plan Task 2) against a fake target
# under scratch\fake-programs. The live install is only read, in (a): its
# listing and mtimes are hashed before and after a -DryRun aimed at it without
# -Live, which guard (2) must refuse with exit 2. Every other step works on
#   scratch\fake-programs\SeaShell  resources\app.asar (empty) and SeaShell.exe
#                                   (a copy of cmd.exe, so a process can run
#                                   from it, started hidden and stopped by pid)
# and the tree is removed at the end. Prints one ok or FAIL line per letter;
# exits 1 on any FAIL.
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$install = "$PSScriptRoot\install-native.ps1"
$source = "$root\release\win-native"
$fakeRoot = "$root\scratch\fake-programs"
$fake = "$fakeRoot\SeaShell"
$live = [IO.Path]::GetFullPath("$env:LOCALAPPDATA\Programs\SeaShell").TrimEnd('\')
if (-not $env:LOCALAPPDATA -or $fake -ieq $live -or $live.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
  Write-Output "FAIL setup: the fake target $fake and the live path $live are not apart"
  exit 1
}
$failed = $false
function Pass([string]$line) { Write-Output "ok $line" }
function Fail([string]$line) { Write-Output "FAIL $line"; $script:failed = $true }

# The orchestrator's audit format: one "<relative path>|<size or d>|<mtime ticks>"
# line per entry, sorted by full name, joined with newlines, SHA-256. -Fresh
# re-reads each entry's own attributes: a folder made seconds ago can show a
# stale mtime in its parent's listing until NTFS catches up, which is not a write.
function Get-ListingHash([string]$dir, [switch]$Fresh) {
  $lines = @()
  if (Test-Path -LiteralPath $dir) {
    $lines = @(Get-ChildItem -LiteralPath $dir -Recurse -Force | Sort-Object FullName | ForEach-Object {
      if ($Fresh) { $_.Refresh() }
      $size = if ($_.PSIsContainer) { 'd' } else { $_.Length }
      "$($_.FullName.Substring($dir.Length))|$size|$($_.LastWriteTimeUtc.Ticks)"
    })
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines -join "`n")) | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Get-Siblings([string]$dir) {
  $parent = Split-Path -Parent $dir
  $leaf = Split-Path -Leaf $dir
  return ((@(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$leaf*" } | ForEach-Object Name) | Sort-Object) -join ',')
}
# Runs the script in its own powershell.exe so its exit code is its own.
function Invoke-Install([string[]]$argv) {
  $ErrorActionPreference = 'Continue'
  $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $install @argv 2>&1 | Out-String).Trim()
  return @{ code = $LASTEXITCODE; out = ($out -replace '\s*\r?\n\s*', ' / ') }
}
function Get-Runners([string]$dir) {
  return @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase) })
}
function Get-Sha([string]$file) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

# A leftover tree from an earlier run is removed first, unless something runs from it.
if (Test-Path -LiteralPath $fakeRoot) {
  if ((Get-Runners $fakeRoot).Count -gt 0) { Write-Output "FAIL setup: a process runs from $fakeRoot"; exit 1 }
  Remove-Item -LiteralPath $fakeRoot -Recurse -Force
}

# The fake target.
New-Item -ItemType Directory -Force -Path "$fake\resources" | Out-Null
[IO.File]::WriteAllBytes("$fake\resources\app.asar", [byte[]]@())
Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination "$fake\SeaShell.exe"

# (a) The live path, no -Live: exit 2; the real folder is only listed, before and after.
try {
  $before = Get-ListingHash $live
  $sibBefore = Get-Siblings $live
  $r = Invoke-Install @('-DryRun', '-Target', $live)
  $after = Get-ListingHash $live
  $sibAfter = Get-Siblings $live
  if ($r.code -eq 2 -and $before -eq $after -and $sibBefore -eq $sibAfter) {
    Pass "a: -DryRun on $live without -Live exits 2, real folder unchanged (before $before, after $after)"
  } else {
    Fail "a: exit $($r.code) [$($r.out)], before $before, after $after, siblings [$sibBefore] -> [$sibAfter]"
  }
} catch { Fail "a: $($_.Exception.Message)" }

# (b) -DryRun on the fake: exit 0, the plan printed, nothing created.
try {
  $before = Get-ListingHash $fakeRoot -Fresh
  $r = Invoke-Install @('-DryRun', '-Source', $source, '-Target', $fake)
  $after = Get-ListingHash $fakeRoot -Fresh
  if ($r.code -eq 0 -and $r.out -like 'would install *' -and $before -eq $after) {
    Pass "b: -DryRun on the fake exits 0 and creates nothing ($($r.out))"
  } else {
    Fail "b: exit $($r.code) [$($r.out)], listing $before -> $after"
  }
} catch { Fail "b: $($_.Exception.Message)" }

# (c) A process runs from the fake: exit 3, nothing changed; only that pid is stopped.
$proc = $null
$before = $null
$after = $null
$r = @{ code = -1; out = 'not run' }
try {
  $proc = Start-Process -FilePath "$fake\SeaShell.exe" -ArgumentList '/c', 'pause' -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40; $i++) {
    $seen = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)"
    if ($seen -and $seen.ExecutablePath) { break }
    Start-Sleep -Milliseconds 250
  }
  $before = Get-ListingHash $fakeRoot -Fresh
  $r = Invoke-Install @('-Source', $source, '-Target', $fake)
  $after = Get-ListingHash $fakeRoot -Fresh
} catch { $r = @{ code = -1; out = $_.Exception.Message } }
finally {
  if ($proc) {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    [void]$proc.WaitForExit(10000)
  }
}
$gone = $proc -and $proc.HasExited -and (Get-Runners $fakeRoot).Count -eq 0
if ($r.code -eq 3 -and $before -eq $after -and $gone) {
  Pass "c: install while pid $($proc.Id) runs the fake exits 3, nothing changed, pid $($proc.Id) stopped and gone ($($r.out))"
} else {
  $procId = if ($proc) { $proc.Id } else { 'none' }
  Fail "c: exit $($r.code) [$($r.out)], listing $before -> $after, pid $procId gone $gone"
}

# (d) The install: exit 0, INSTALLED.json, the backup with app.asar, the exe's sha.
try {
  $r = Invoke-Install @('-Source', $source, '-Target', $fake)
  $backups = @(Get-ChildItem -LiteralPath $fakeRoot -Directory -Force | Where-Object { $_.Name -like 'SeaShell.electron-*' })
  $want = Get-Sha "$source\SeaShell.exe"
  $got = if (Test-Path -LiteralPath "$fake\SeaShell.exe") { Get-Sha "$fake\SeaShell.exe" } else { 'missing' }
  $info = if (Test-Path -LiteralPath "$fake\INSTALLED.json") { [IO.File]::ReadAllText("$fake\INSTALLED.json") | ConvertFrom-Json } else { $null }
  $okBackup = $backups.Count -eq 1 -and (Test-Path -LiteralPath "$($backups[0].FullName)\resources\app.asar")
  if ($r.code -eq 0 -and $info -and $okBackup -and $info.backup -ieq $backups[0].FullName -and $want -eq $got) {
    Pass "d: install exits 0, INSTALLED.json $($info.version) $($info.build.Substring(0, 12)), backup $($backups[0].Name) holds app.asar, SeaShell.exe sha $($got.Substring(0, 12)) as the source ($($r.out))"
  } else {
    Fail "d: exit $($r.code) [$($r.out)], INSTALLED.json $([bool]$info), backups $($backups.Count) ok $okBackup, sha $got want $want"
  }
} catch { Fail "d: $($_.Exception.Message)" }

# (e) -Rollback: exit 0, app.asar back, a .rolledback- folder, no backup left.
try {
  $r = Invoke-Install @('-Rollback', '-Target', $fake)
  $rolled = @(Get-ChildItem -LiteralPath $fakeRoot -Directory -Force | Where-Object { $_.Name -like 'SeaShell.rolledback-*' })
  $left = @(Get-ChildItem -LiteralPath $fakeRoot -Directory -Force | Where-Object { $_.Name -like 'SeaShell.electron-*' })
  $asar = Test-Path -LiteralPath "$fake\resources\app.asar"
  if ($r.code -eq 0 -and $asar -and $rolled.Count -eq 1 -and $left.Count -eq 0 -and (Test-Path -LiteralPath "$($rolled[0].FullName)\INSTALLED.json")) {
    Pass "e: -Rollback exits 0, app.asar back under the target, $($rolled[0].Name) holds the native install ($($r.out))"
  } else {
    Fail "e: exit $($r.code) [$($r.out)], app.asar $asar, rolledback $($rolled.Count), electron left $($left.Count)"
  }
} catch { Fail "e: $($_.Exception.Message)" }

# (f) Remove the fake tree.
try {
  if ((Get-Runners $fakeRoot).Count -gt 0) { throw "a process still runs from $fakeRoot" }
  Remove-Item -LiteralPath $fakeRoot -Recurse -Force
  if (Test-Path -LiteralPath $fakeRoot) { Fail "f: $fakeRoot is still there" } else { Pass "f: $fakeRoot removed" }
} catch { Fail "f: $($_.Exception.Message)" }

if ($failed) { exit 1 }
exit 0
