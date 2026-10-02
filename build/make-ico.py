#!/usr/bin/env python3
"""
Generates build/icon.ico, the Windows app and taskbar icon, from the master
PNG at icon/icon-1024.png (which make-icon.py and the icon README produce).

Each size is downsampled from the 1024 master with Lanczos rather than letting
Windows scale one large frame, so 16 and 24 stay crisp in the taskbar and
title bar. Needs Pillow (python3 -m pip install Pillow): python3 build/make-ico.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "icon" / "icon-1024.png"
OUT = ROOT / "build" / "icon.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    master = Image.open(SRC).convert("RGBA")
    frames = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    # Pillow writes the largest image first and every listed size from it,
    # but passing the pre-scaled frames keeps the Lanczos output per size.
    frames[-1].save(
        OUT,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=frames[:-1],
    )
    print(f"wrote {OUT} ({', '.join(str(s) for s in SIZES)})")


if __name__ == "__main__":
    main()
