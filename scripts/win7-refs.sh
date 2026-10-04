#!/bin/bash
# Read the Windows 7 Aero theme bitmaps out of the cached Windows 7 Ultimate SP1 x64 ISO
# (en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso, SHA1 36ae90defbad9d9539e649b193ae573b77a71c83,
# the same constant as ~/pc-migration/windows/mac-mode/tools/win7_extract.sh) for side-by-side
# comparison with the native shell's own painting.
#
# What it does: verifies the ISO sha1, extracts sources/install.wim into a temporary work dir (removed
# on exit), copies Windows/Resources/Themes/Aero/aero.msstyles from image 4 into <dest>, installs pefile
# into ~/.venvs/design, then dumps every PE resource whose bytes start with a PNG or BMP signature to
# <dest>/<type>_<id>.png or .bmp (bytes as found) and writes <dest>/INDEX.txt (id, type, bytes, size).
#
# Reference files only: nothing is installed, registered or applied. The msstyles is never loaded as a
# theme, nothing is copied into a Windows folder, and the ISO is never downloaded or written to.
#   scripts/win7-refs.sh <iso> <dest>
# Needs 7z (ISO/UDF and WIM readers).
set -euo pipefail
if [ $# -ne 2 ]; then echo "usage: $0 <iso> <dest>"; exit 2; fi
ISO="$1"; DEST="$2"
ISO_SHA1=36ae90defbad9d9539e649b193ae573b77a71c83
IMAGE=4   # install.wim image 4 = Ultimate
PY="$HOME/.venvs/design/bin/python"
MSSTYLES_PATH="Windows/Resources/Themes/Aero/aero.msstyles"

[ -f "$ISO" ] || { echo "no ISO at $ISO (it is never downloaded here)"; exit 1; }
echo "verifying ISO sha1"
echo "$ISO_SHA1  $ISO" | sha1sum -c --quiet || { echo "ISO sha1 mismatch, refusing"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "extracting sources/install.wim"
7z e -y -o"$WORK" "$ISO" sources/install.wim > /dev/null
mkdir -p "$DEST"
echo "extracting $MSSTYLES_PATH from image $IMAGE"
7z e -y -o"$DEST" "$WORK/install.wim" "$IMAGE/$MSSTYLES_PATH" > /dev/null
[ -s "$DEST/aero.msstyles" ] || { echo "aero.msstyles not found in image $IMAGE"; exit 1; }
rm -f "$WORK/install.wim"

"$PY" -c 'import pefile' 2>/dev/null || "$PY" -m pip install --quiet pefile

echo "dumping image resources"
"$PY" - "$DEST/aero.msstyles" "$DEST" "$IMAGE" <<'PYEOF'
import os
import struct
import sys

import pefile

src, dest, image = sys.argv[1], sys.argv[2], sys.argv[3]
pe = pefile.PE(src, fast_load=True)
pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]])


def label(entry, kind):
    if entry.name is not None:
        return str(entry.name)
    if kind == "type":
        return pefile.RESOURCE_TYPE.get(entry.id, str(entry.id))
    return str(entry.id)


def dims(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    if data[:2] == b"BM" and len(data) >= 26:
        hdr = struct.unpack("<I", data[14:18])[0]
        if hdr == 12:
            w, h = struct.unpack("<HH", data[18:22])
        else:
            w, h = struct.unpack("<ii", data[18:26])
        return w, abs(h)
    return 0, 0


rows = []
for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
    tname = label(t, "type")
    for r in (t.directory.entries if hasattr(t, "directory") else []):
        rid = label(r, "id")
        langs = r.directory.entries if hasattr(r, "directory") else []
        for i, lang in enumerate(langs):
            ds = lang.data.struct
            data = pe.get_data(ds.OffsetToData, ds.Size)
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                ext = "png"
            elif data[:2] == b"BM":
                ext = "bmp"
            else:
                continue
            suffix = "" if len(langs) == 1 else "_%d" % lang.id
            safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in tname)
            safe_r = "".join(c if c.isalnum() or c in "-_" else "_" for c in rid)
            fname = "%s_%s%s.%s" % (safe_t, safe_r, suffix, ext)
            with open(os.path.join(dest, fname), "wb") as fh:
                fh.write(data)
            w, h = dims(data)
            rows.append((rid, tname, len(data), w, h, fname))


def key(row):
    rid = row[0]
    return (row[1], 0, int(rid), "") if rid.isdigit() else (row[1], 1, 0, rid)


rows.sort(key=key)
with open(os.path.join(dest, "INDEX.txt"), "w") as fh:
    fh.write("# aero.msstyles image resources, source image %s; columns: id type bytes WxH file\n" % image)
    for rid, tname, n, w, h, fname in rows:
        fh.write("%s\t%s\t%d\t%dx%d\t%s\n" % (rid, tname, n, w, h, fname))
print("dumped %d images" % len(rows))
PYEOF
echo "done: $(grep -vc '^#' "$DEST/INDEX.txt") images in $DEST (INDEX.txt, aero.msstyles kept as a reference file)"
