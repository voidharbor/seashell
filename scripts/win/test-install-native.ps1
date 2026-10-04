# Exercise install-native.ps1 and uninstall-native.ps1 (Phase 3 plan Task 2)
# against a fake target under scratch\fake-programs. The live install is only
# read, in (a): its listing and mtimes are hashed, and its own mtime and the
# Programs children listing read, before and after a -DryRun aimed at it without
# -Live, which guard (2) must refuse with exit 2. Every other step works on
#   scratch\fake-programs\SeaShell  resources\app.asar (empty) and SeaShell.exe
#                                   (a copy of cmd.exe, so a process can run
#                                   from it, started hidden and stopped by pid)
# and the tree is removed in (f); (g) builds it again for the uninstall and
# removes it. Prints one ok or FAIL line per letter; exits 1 on any FAIL.
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$install = "$PSScriptRoot\install-native.ps1"
$uninstall = "$PSScriptRoot\uninstall-native.ps1"
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
# The folder's own mtime, and a hash of its parent's direct children (name,
# size or d, mtime ticks), for (a): the listing hash above leaves both out.
function Get-OwnMtime([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return 'absent' }
  return [IO.Directory]::GetLastWriteTimeUtc($dir).ToString('o')
}
function Get-ChildrenHash([string]$dir) {
  $lines = @()
  if (Test-Path -LiteralPath $dir) {
    $lines = @(Get-ChildItem -LiteralPath $dir -Force | Sort-Object Name | ForEach-Object {
      $size = if ($_.PSIsContainer) { 'd' } else { $_.Length }
      "$($_.Name)|$size|$($_.LastWriteTimeUtc.Ticks)"
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
function Invoke-Ps([string]$file, [string[]]$argv) {
  $ErrorActionPreference = 'Continue'
  $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @argv 2>&1 | Out-String).Trim()
  return @{ code = $LASTEXITCODE; out = ($out -replace '\s*\r?\n\s*', ' / ') }
}
function Invoke-Install([string[]]$argv) { return (Invoke-Ps $install $argv) }
function Invoke-Uninstall([string[]]$argv) { return (Invoke-Ps $uninstall $argv) }
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
  $programsDir = Split-Path -Parent $live
  $before = Get-ListingHash $live
  $sibBefore = Get-Siblings $live
  $ownBefore = Get-OwnMtime $live
  $kidsBefore = Get-ChildrenHash $programsDir
  $r = Invoke-Install @('-DryRun', '-Target', $live)
  $after = Get-ListingHash $live
  $sibAfter = Get-Siblings $live
  $ownAfter = Get-OwnMtime $live
  $kidsAfter = Get-ChildrenHash $programsDir
  $extra = "root mtime $ownBefore -> $ownAfter; Programs children $kidsBefore -> $kidsAfter"
  if ($r.code -eq 2 -and $before -eq $after -and $sibBefore -eq $sibAfter -and $ownBefore -eq $ownAfter -and $kidsBefore -eq $kidsAfter) {
    Pass "a: -DryRun on $live without -Live exits 2, real folder unchanged (before $before, after $after; $extra)"
  } else {
    Fail "a: exit $($r.code) [$($r.out)], before $before, after $after, siblings [$sibBefore] -> [$sibAfter]; $extra"
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

# (g) uninstall-native.ps1 on a fresh fake tree: -DryRun on a native install
# changes nothing, a folder that is not a native install exits 5 and stays, and
# uninstall after an install goes back to the Electron backup. The tree is
# removed at the end.
try {
  if (Test-Path -LiteralPath $fakeRoot) { throw "$fakeRoot is still there after (f)" }
  New-Item -ItemType Directory -Force -Path "$fake\resources" | Out-Null
  [IO.File]::WriteAllBytes("$fake\resources\app.asar", [byte[]]@())
  Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination "$fake\SeaShell.exe"
  $other = "$fakeRoot\NotNative"
  New-Item -ItemType Directory -Force -Path $other | Out-Null
  [IO.File]::WriteAllText("$other\keep.txt", 'keep')
  $bad = @()
  $r = Invoke-Install @('-Source', $source, '-Target', $fake)
  if ($r.code -ne 0) { $bad += "install exit $($r.code) [$($r.out)]" }
  $before = Get-ListingHash $fakeRoot -Fresh
  $dry = Invoke-Uninstall @('-DryRun', '-Target', $fake)
  $after = Get-ListingHash $fakeRoot -Fresh
  if ($dry.code -ne 0 -or $dry.out -notlike 'would roll back *' -or $before -ne $after) { $bad += "-DryRun exit $($dry.code) [$($dry.out)], listing $before -> $after" }
  $before = Get-ListingHash $other -Fresh
  $non = Invoke-Uninstall @('-Target', $other)
  $after = Get-ListingHash $other -Fresh
  if ($non.code -ne 5 -or -not (Test-Path -LiteralPath "$other\keep.txt") -or $before -ne $after) { $bad += "non-native exit $($non.code) [$($non.out)], keep.txt $(Test-Path -LiteralPath "$other\keep.txt"), listing $before -> $after" }
  $un = Invoke-Uninstall @('-Target', $fake)
  $rolled = @(Get-ChildItem -LiteralPath $fakeRoot -Directory -Force | Where-Object { $_.Name -like 'SeaShell.rolledback-*' })
  $left = @(Get-ChildItem -LiteralPath $fakeRoot -Directory -Force | Where-Object { $_.Name -like 'SeaShell.electron-*' })
  $asar = Test-Path -LiteralPath "$fake\resources\app.asar"
  $okRolled = $rolled.Count -eq 1 -and (Test-Path -LiteralPath "$($rolled[0].FullName)\INSTALLED.json")
  if ($un.code -ne 0 -or $un.out -notlike 'rolled back to *' -or -not $asar -or -not $okRolled -or $left.Count -ne 0) { $bad += "uninstall exit $($un.code) [$($un.out)], app.asar $asar, rolledback $($rolled.Count), electron left $($left.Count)" }
  if ((Get-Runners $fakeRoot).Count -gt 0) { throw "a process runs from $fakeRoot" }
  Remove-Item -LiteralPath $fakeRoot -Recurse -Force
  if (Test-Path -LiteralPath $fakeRoot) { $bad += "$fakeRoot is still there" }
  if ($bad.Count -eq 0) {
    Pass "g: uninstall -DryRun on the fake native install exits 0 and changes nothing ($($dry.out)); on $other exits 5 and leaves it ($($non.out)); after an install exits 0 ($($un.out)), app.asar back, $($rolled[0].Name) holds the native install; $fakeRoot removed"
  } else {
    Fail "g: $($bad -join '; ')"
  }
} catch { Fail "g: $($_.Exception.Message)" }
finally {
  if ((Test-Path -LiteralPath $fakeRoot) -and (Get-Runners $fakeRoot).Count -eq 0) { Remove-Item -LiteralPath $fakeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failed) { exit 1 }
exit 0
