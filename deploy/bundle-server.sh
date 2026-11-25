#!/bin/sh
# Build the signed server bundle shipped with the desktop client (stage 6.1a).
#
#   ROSTALK_SIGN_KEY=/path/to/rostalk-release.key sh deploy/bundle-server.sh
#
# Both Linux architectures are built from the current commit by
# deploy/release.sh, then the whole signed release is copied to
# client/src-tauri/resources/server. The directory is ignored by git: binaries
# are release artefacts, not sources.
#
# The desktop client looks for resource_dir()/server, then <exe>/server, then
# ROSTALK_SERVER_BUNDLE. `make client-portable` puts a copy next to rostalk.exe.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/client/src-tauri/resources/server"

# The release key is deliberately outside the repository. Allow an override;
# otherwise use the per-user default, or the pre-rename one (ADR 0033).
if [ -z "${ROSTALK_SIGN_KEY:-}" ]; then
	for candidate in "${USERPROFILE:-$HOME}/.rostalk/release/rostalk-release.key" 		"${USERPROFILE:-$HOME}/.hearth/release/hearth-release.key"; do
		if [ -f "$candidate" ]; then
			ROSTALK_SIGN_KEY=$candidate
			export ROSTALK_SIGN_KEY
			break
		fi
	done
fi

echo "==> building the server release from $(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo 'this tree')"
DIST="$OUT" sh "$ROOT/deploy/release.sh"

# release.sh writes exactly the files the client uploads. Verify the two
# architectures are present before declaring success.
for arch in amd64 arm64; do
	asset=$(find "$OUT" -maxdepth 1 -name "rostalk-server_*_linux_${arch}" -type f | head -n 1)
	if [ -z "$asset" ]; then
		echo "bundle-server.sh: no linux/${arch} binary was produced" >&2
		exit 1
	fi
done
if [ ! -f "$OUT/SHA256SUMS.sig" ]; then
	echo "bundle-server.sh: SHA256SUMS.sig is missing; the bundle would be rejected" >&2
	exit 1
fi

echo
echo "server bundle is ready in $OUT:"
ls -l "$OUT"
