#!/bin/sh
# Runs gremlins for one server package (docs/TEST-QUALITY.md).
#
# Why a wrapper instead of a plain command in the Makefile:
#
#  * gremlins copies the module to a temporary directory. On Windows that
#    directory sometimes cannot be removed because a `go` child still holds a
#    file; gremlins then exits 1 *after* writing a complete report. Treating
#    that as a failed run would be wrong, so the run counts as successful when
#    the JSON report exists.
#  * The package list and report names live in one place.
#
# Usage: tools/mutants/gremlins.sh perms
#        GREMLINS=/path/to/gremlins tools/mutants/gremlins.sh state

set -u

pkg=${1:-}
if [ -z "$pkg" ]; then
    echo "usage: $0 <perms|roles|chat|state>" >&2
    exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root/server" || exit 1

exe=${GREMLINS:-gremlins}
report="mutants-$pkg.json"

set +e
"$exe" unleash --output "$report" "./internal/$pkg"
status=$?
set -e

if [ -s "$report" ]; then
    echo "[mutants] $pkg: report written to server/$report (gremlins exit $status)"
    exit 0
fi

echo "[mutants] $pkg: gremlins produced no report (exit $status)" >&2
exit "$status"
