#!/usr/bin/env bash
# Put the official Node linux-x64 build the core's node-pty was compiled for
# into <worktree>/out/node (bin/node, LICENSE, VERSION), checked against
# nodejs.org's SHASUMS256.txt. pack-native.ps1 ships it as resources\core\node
# and the shell spawns the core with it, so the distro needs no node of its own.
# The version defaults to the node on PATH, the one npm built node-pty with;
# the script ends by loading node-pty under the fetched node and spawning a pty.
# Run from WSL: scripts/win/fetch-node.sh [worktree] [vX.Y.Z]
set -euo pipefail
WT="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
VER="${2:-$(node --version)}"
case "$VER" in v*) ;; *) VER="v$VER" ;; esac
NAME="node-$VER-linux-x64"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/seashell-build/node/$VER"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$NAME.tar.xz" ] || ! (cd "$CACHE" && grep " $NAME.tar.xz\$" SHASUMS256.txt | sha256sum -c --status -); then
  curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/$VER/SHASUMS256.txt"
  curl -fsSL -o "$CACHE/$NAME.tar.xz" "https://nodejs.org/dist/$VER/$NAME.tar.xz"
  (cd "$CACHE" && grep " $NAME.tar.xz\$" SHASUMS256.txt | sha256sum -c --status -) || { echo "fetch-node: $NAME.tar.xz does not match SHASUMS256.txt" >&2; exit 1; }
fi
OUT="$WT/out/node"
rm -rf "$OUT" "$OUT.tmp"
mkdir -p "$OUT.tmp"
tar -xJf "$CACHE/$NAME.tar.xz" -C "$OUT.tmp" --strip-components=1 "$NAME/bin/node" "$NAME/LICENSE"
echo "$VER" > "$OUT.tmp/VERSION"
mv -T "$OUT.tmp" "$OUT"

# node-pty's ABI has to match: load it and run one pty under the fetched node.
"$OUT/bin/node" -e '
const pty = require(process.argv[1])
const p = pty.spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 40, rows: 5 })
let out = ""
p.onData((d) => { out += d })
p.onExit(() => {
  if (!out.includes("pty-ok")) { console.error("fetch-node: the pty printed " + JSON.stringify(out)); process.exit(1) }
  console.log("node-pty ok under node " + process.version + " (abi " + process.versions.modules + ")")
})
' "$WT/node_modules/node-pty"
echo "fetched $OUT ($VER, $(du -m "$OUT/bin/node" | cut -f1) MB)"
