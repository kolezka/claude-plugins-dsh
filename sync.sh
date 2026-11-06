#!/bin/sh
# Copy the canonical claude-compat.js into each plugin checkout's dsh/ directory,
# or with --check report any copy that drifted. Usage:
#   ./sync.sh [--check] <plugin-dir>...
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/claude-compat.js"
check=0
[ "${1-}" = --check ] && { check=1; shift; }
[ $# -gt 0 ] || { echo "usage: $0 [--check] <plugin-dir>..." >&2; exit 64; }
status=0
for dir in "$@"; do
  dst="$dir/dsh/claude-compat.js"
  if [ "$check" = 1 ]; then
    if ! cmp -s "$src" "$dst"; then echo "drift: $dst"; status=1; fi
  else
    mkdir -p "$dir/dsh"
    cp "$src" "$dst"
    echo "synced: $dst"
  fi
done
exit $status
