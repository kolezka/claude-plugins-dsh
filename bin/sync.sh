#!/bin/sh
# Source-checkout convenience wrapper; published users use claude-plugins-dsh sync.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/../dist/bin/cli.js" sync "$@"
