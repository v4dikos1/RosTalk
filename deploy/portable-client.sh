#!/bin/sh
# Assemble a portable Windows client folder: rostalk.exe + README.
#
#   sh deploy/portable-client.sh
#
# Run after `make build-client`. Since P13 the client ships without the server
# bundle (ADR 0026): servers are installed with rostalk-server-setup or with
# install.sh on the Linux machine. `make release` zips the same layout as
# RosTalk-<version>-portable.zip.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXE=${EXE:-"$ROOT/client/src-tauri/target/release/rostalk.exe"}
OUT="${OUT:-$ROOT/dist/rostalk-client-portable}"
RELEASE_REPO=${ROSTALK_RELEASE_REPO:-v4dikos1/RosTalk}

[ -f "$EXE" ] || {
	echo "portable-client.sh: $EXE is missing; run make build-client first" >&2
	exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$EXE" "$OUT/rostalk.exe"

cat >"$OUT/README.txt" <<EOF2
RosTalk portable client
======================

Run rostalk.exe. Nothing is installed: settings and the identity live in your
Windows profile, as with the installed client. Updates from the client
install the regular per-user version (RosTalk-Setup-<version>.exe).

Want your own server? Releases: https://github.com/$RELEASE_REPO/releases/latest
  - from Windows: RosTalk-Server-Setup-<version>.zip (installs over SSH);
  - on the Linux server:
    curl -fsSL https://github.com/$RELEASE_REPO/releases/latest/download/install.sh | sudo sh

Ports a server needs: TCP 7443, TCP 7881, UDP 7882 (a domain also needs
TCP 80 and 443).
EOF2

echo "portable client is in $OUT:"
ls -l "$OUT"
