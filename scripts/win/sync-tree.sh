#!/usr/bin/env bash
# Mirror the redesign worktree into the Windows build tree. node_modules, out and
# release are rebuilt on the Windows side with the Windows Node, never copied.
# scratch holds live scratch userData folders, so --delete must never reach it.
set -euo pipefail
SRC="${1:-$HOME/seashell-wt/redesign}"
DST="${2:-/mnt/c/seashell-build/redesign}"
mkdir -p "$DST"
# One sync at a time: two rsyncs with --delete race on each other's temp files.
exec 9>/tmp/seashell-1002-sync.lock
flock 9
rsync -a --delete \
  --exclude node_modules --exclude out --exclude release --exclude .git \
  --exclude host-build --exclude bakeoff --exclude scratch \
  "$SRC/" "$DST/"
echo "synced $SRC -> $DST"
