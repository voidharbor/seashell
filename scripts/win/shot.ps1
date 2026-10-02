# Captures one scratch shell's window to a PNG with PrintWindow
# (PW_RENDERFULLCONTENT), so only that window is captured, never what sits on
# top of it. The window is found by pid plus class SeaShellHost, never by
# title. Usage: shot.ps1 -Pid <shell pid> -Out C:\...\name.png
param(
  # -Pid on the command line; $Pid itself is PowerShell's read-only own pid.
  [Parameter(Mandatory = $true)][Alias('Pid')][int]$ShellPid,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$WaitSeconds = 10
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class DShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "SeaShellHost") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
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
      b.Save(path, ImageFormat.Png);
      return w + "x" + hh;
    }
  }
}
'@

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  $h = [DShot]::Find([uint32]$ShellPid)
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if ($h -eq [IntPtr]::Zero) { Write-Error "no SeaShellHost window for pid $ShellPid"; exit 1 }
Write-Output ("shot: pid $ShellPid hwnd 0x{0:x} title '{1}' {2} -> {3}" -f $h.ToInt64(), [DShot]::Title($h), [DShot]::Save($h, $Out), $Out)
