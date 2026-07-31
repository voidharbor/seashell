#!/usr/bin/env python3
"""
Generates SeaShell's app icon.

A logarithmic spiral (the nautilus shell) with a terminal cursor at its mouth —
the two things the app is named for, in one mark. Drawn as real geometry rather
than traced art so it stays crisp at 16px, where an illustration would mud.

Outputs build/icon.svg plus a full .iconset, then calls iconutil for the .icns.
"""
import math
import subprocess
import sys
from pathlib import Path

BUILD = Path(__file__).parent
SVG = BUILD / "icon.svg"
ICONSET = BUILD / "icon.iconset"
ICNS = BUILD / "icon.icns"

S = 1024                      # master artboard
CX, CY = S * 0.50, S * 0.53   # spiral focus, nudged low so it optically centers

# Deep sea ground, cyan-to-warm shell. Reads on both light and dark Docks.
BG_TOP, BG_BOT = "#0E2430", "#071319"
SHELL_A, SHELL_B, SHELL_C = "#8FF3E8", "#3FBFD4", "#1E6E8C"
CURSOR = "#9FF7C4"


def spiral_points(turns=2.62, a=6.1, b=0.246, steps=760):
    """Logarithmic spiral r = a*e^(b*theta) — the growth curve a real shell follows."""
    pts = []
    total = turns * 2 * math.pi
    for i in range(steps + 1):
        t = total * i / steps
        r = a * math.exp(b * t)
        pts.append((CX + r * math.cos(t - math.pi / 2), CY + r * math.sin(t - math.pi / 2)))
    return pts


def tapered_spiral(inner=16.0, outer=104.0):
    """
    Builds a closed outline by offsetting the spiral normally, wide at the mouth
    and narrow at the core. A plain stroke would be uniform width and read as a
    coil of wire rather than a shell.
    """
    pts = spiral_points()
    n = len(pts)
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        px, py = pts[max(i - 1, 0)]
        nx, ny = pts[min(i + 1, n - 1)]
        dx, dy = nx - px, ny - py
        mag = math.hypot(dx, dy) or 1.0
        ox, oy = -dy / mag, dx / mag
        # Ease the width so the taper accelerates toward the opening.
        f = (i / (n - 1)) ** 1.55
        w = (inner + (outer - inner) * f) / 2
        left.append((x + ox * w, y + oy * w))
        right.append((x - ox * w, y - oy * w))

    d = [f"M {left[0][0]:.2f} {left[0][1]:.2f}"]
    d += [f"L {x:.2f} {y:.2f}" for x, y in left[1:]]
    d += [f"L {x:.2f} {y:.2f}" for x, y in reversed(right)]
    d.append("Z")
    return " ".join(d)


def build_svg():
    path = tapered_spiral()
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/>
      <stop offset="1" stop-color="{BG_BOT}"/>
    </linearGradient>
    <linearGradient id="shell" gradientUnits="userSpaceOnUse"
                    x1="{S*0.24}" y1="{S*0.20}" x2="{S*0.78}" y2="{S*0.84}">
      <stop offset="0"    stop-color="{SHELL_A}"/>
      <stop offset="0.52" stop-color="{SHELL_B}"/>
      <stop offset="1"    stop-color="{SHELL_C}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#3FBFD4" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#3FBFD4" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="{S}" height="{S}" rx="{S*0.2246}" fill="url(#bg)"/>
  <circle cx="{CX}" cy="{CY}" r="{S*0.40}" fill="url(#glow)"/>
  <path d="{path}" fill="url(#shell)"/>
  <rect x="{S*0.399}" y="{S*0.836}" width="{S*0.202}" height="{S*0.040}"
        rx="{S*0.020}" fill="{CURSOR}"/>
</svg>
"""


def main():
    SVG.write_text(build_svg(), encoding="utf-8")
    ICONSET.mkdir(exist_ok=True)

    # The exact set macOS expects; omitting any of them makes iconutil fail.
    specs = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
             (256, 1), (256, 2), (512, 1), (512, 2)]
    for size, scale in specs:
        px = size * scale
        name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        subprocess.run(
            ["rsvg-convert", "-w", str(px), "-h", str(px), str(SVG), "-o", str(ICONSET / name)],
            check=True,
        )

    subprocess.run(["iconutil", "-c", "icns", str(ICONSET), "-o", str(ICNS)], check=True)
    print(f"wrote {ICNS} ({ICNS.stat().st_size} bytes)")


if __name__ == "__main__":
    sys.exit(main())
