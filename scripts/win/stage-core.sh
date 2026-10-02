#!/bin/sh
# Stage the core bundle from the Windows release layout into the distro's own
# filesystem (spec 4.5), so node and node-pty load from ext4, not from /mnt/c.
# The native shell runs it before the first core spawn, unless SEASHELL_CORE_DIR
# is set: wsl.exe -d Ubuntu-24.04 -e sh <this file> <mnt path of resources/core> <version>
# The version stays put while the bundle changes, so the BUILD file (the sha256
# of index.cjs, written by pack-native.ps1) is compared too. Prints one line:
# "staged <dst>" after a copy, "current <dst>" when nothing changed.
set -eu
src="${1:?usage: stage-core.sh <mnt path of resources/core> <version>}"
version="${2:?usage: stage-core.sh <mnt path of resources/core> <version>}"
base="$HOME/.cache/seashell-win/core"
dst="$base/$version"
mkdir -p "$base"

# Two shells starting at once stage one at a time.
exec 9>"$base/.lock"
if command -v flock >/dev/null 2>&1; then flock -w 50 9; fi

current() {
  [ -f "$dst/VERSION" ] && [ "$(cat "$dst/VERSION")" = "$version" ] || return 1
  [ -f "$dst/index.cjs" ] || return 1
  if [ -f "$src/BUILD" ]; then cmp -s "$src/BUILD" "$dst/BUILD" || return 1; fi
  return 0
}
if current; then echo "current $dst"; exit 0; fi

[ -f "$src/index.cjs" ] || { echo "error: no index.cjs in $src" >&2; exit 1; }
rm -rf "$dst.tmp"
mkdir -p "$dst.tmp"
cp -r "$src/." "$dst.tmp/"
# A running core keeps its open files after the rename; only new spawns see the new copy.
if [ -e "$dst" ]; then
  rm -rf "$dst.old"
  mv -T "$dst" "$dst.old"
fi
mv -T "$dst.tmp" "$dst"
rm -rf "$dst.old"
echo "staged $dst"
