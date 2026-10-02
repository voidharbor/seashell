# Bake-off candidate D (spec section 3): launch the native Win32 floor, wait
# for its ConPTY wsl.exe pane, idle, capture its own window, measure at W10,
# and always stop the tree by root pid.
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$exe = "$root\bakeoff\d-build\Release\bakeoff-win32.exe"
$shot = "$root\bakeoff\D-native.png"
. "$root\scripts\win\app-tree.ps1"

# PrintWindow with PW_RENDERFULLCONTENT captures this window only, never
# whatever happens to be on top of it on the desktop.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class DShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public static string Save(IntPtr h, string path) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));  // per monitor v2: real pixel sizes
    RECT r; if (!GetWindowRect(h, out r)) return "GetWindowRect failed";
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    using (Bitmap b = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(b)) {
        IntPtr dc = g.GetHdc();
        bool ok = PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc);
        if (!ok) return "PrintWindow failed";
      }
      int lit = 0, seen = 0;
      for (int y = 0; y < hh; y += 3) for (int x = 0; x < w; x += 3) { Color c = b.GetPixel(x, y); seen++; if (c.G > 128 && c.R < 128) lit++; }
      b.Save(path, ImageFormat.Png);
      return w + "x" + hh + ", green text pixels " + lit + " of " + seen + " sampled";
    }
  }
}
'@

$p = Start-Process -FilePath $exe -WorkingDirectory "$root\bakeoff" -PassThru
Write-Output "candidate D root pid $($p.Id)"
try {
  $deadline = (Get-Date).AddSeconds(20)
  while ($p.MainWindowHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.MainWindowHandle -eq [IntPtr]::Zero) { throw 'candidate D showed no window in 20 s' }
  $deadline = (Get-Date).AddSeconds(30)
  do { Start-Sleep 1; $wsl = @(Get-AppTree $p.Id | Where-Object { $_.Name -eq 'wsl.exe' }) } while ($wsl.Count -eq 0 -and (Get-Date) -lt $deadline)
  if ($wsl.Count -eq 0) { throw 'no wsl.exe in the candidate tree after 30 s' }
  Write-Output "wsl.exe up (pid $($wsl[0].ProcessId)); idling 70 s"
  Start-Sleep 70
  if ($p.HasExited) { throw "candidate D exited with code $($p.ExitCode)" }
  Get-AppTree $p.Id | ForEach-Object { Write-Output ("tree: {0} {1}" -f $_.ProcessId, $_.Name) }
  $p.Refresh()
  Write-Output ("screenshot: " + [DShot]::Save($p.MainWindowHandle, $shot) + " -> $shot")
  $global:LASTEXITCODE = 0
  & "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -Label D-native
  $code = $LASTEXITCODE
  if ($code -eq 2) { Write-Output 'measure: not measured, Edge was open' }
  elseif ($code -ne 0) { Write-Output "measure: failed with exit $code" }
} finally {
  & "$root\scripts\win\stop-tree.ps1" -RootPid $p.Id
}
