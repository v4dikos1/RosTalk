#!/bin/sh
# Build a signed-ish RosTalk server release into dist/.
#
# There is no hosted CI (docs/adr/0015), so this script is the release pipeline.
# It runs on Linux (or in the golang container, see docs/INSTALL.md) because the
# server is Linux-only. It cross-compiles both supported architectures with
# CGO_ENABLED=0, writes SHA256SUMS, signs it with an Ed25519 key and copies the
# installer next to the binaries.
#
#   ROSTALK_SIGN_KEY=/secure/rostalk-release.key sh deploy/release.sh
#   VERSION=1.2.3 ROSTALK_SIGN_KEY=... sh deploy/release.sh
#   sh deploy/release.sh --unsigned      # local test, update will refuse it
#
# The private key never enters the repository. The matching public key is
# deploy/release.pub; it is also embedded in install.sh and in every released
# binary (`rostalk-server version` prints its fingerprint).

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST=${DIST:-"$ROOT/dist"}
GO=${GO:-go}
UNSIGNED=0

for arg in "$@"; do
	case "$arg" in
	--unsigned) UNSIGNED=1 ;;
	-h | --help)
		sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "release.sh: unknown argument $arg" >&2
		exit 2
		;;
	esac
done

VERSION=${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}
COMMIT=${COMMIT:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}
BUILT_AT=${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}

# The installer copied into the release. deploy/release-all.sh passes a copy
# with the release repository written into its default (P13, ADR 0026).
INSTALL_SH=${INSTALL_SH:-"$ROOT/deploy/install.sh"}

PUB_PEM="$ROOT/deploy/release.pub"
if [ ! -f "$PUB_PEM" ]; then
	echo "release.sh: $PUB_PEM is missing" >&2
	exit 1
fi

KEY=${ROSTALK_SIGN_KEY:-}
if [ "$UNSIGNED" -eq 1 ]; then
	echo "release.sh: WARNING: building an unsigned release; rostalk-server update will reject it" >&2
elif [ -z "$KEY" ]; then
	echo "release.sh: ROSTALK_SIGN_KEY is not set." >&2
	echo "  Generate a key once: go run ./cmd/rostalk-sign keygen --out /secure/rostalk-release.key" >&2
	echo "  Commit only its public half as deploy/release.pub." >&2
	echo "  Pass --unsigned only for local testing." >&2
	exit 1
elif [ ! -f "$KEY" ]; then
	echo "release.sh: ROSTALK_SIGN_KEY=$KEY does not exist" >&2
	exit 1
fi

# The public key is embedded in every binary as base64 DER. Deriving it from the
# fixed deploy/release.pub keeps all builds on the same trust root, even when the
# signing key is on another machine.
PUB_B64=$(sed -e '1d' -e '$d' "$PUB_PEM" | tr -d ' \t\r\n')
if ! grep -q "$PUB_B64" "$INSTALL_SH" 2>/dev/null; then
	echo "release.sh: $INSTALL_SH does not embed the public key from deploy/release.pub." >&2
	echo "  Put $PUB_B64 into RELEASE_PUBKEY_PEM in install.sh (see the comment there)." >&2
	exit 1
fi

mkdir -p "$DIST"
rm -f "$DIST"/rostalk-server_* "$DIST/SHA256SUMS" "$DIST/SHA256SUMS.sig" "$DIST/release.json" "$DIST/install.sh" "$DIST/release.pub"

LDFLAGS="-s -w
  -X github.com/v4dikos1/RosTalk/server/internal/version.Version=$VERSION
  -X github.com/v4dikos1/RosTalk/server/internal/version.Commit=$COMMIT
  -X github.com/v4dikos1/RosTalk/server/internal/version.Date=$BUILT_AT
  -X github.com/v4dikos1/RosTalk/server/internal/release.PublicKeyBase64=$PUB_B64"

for arch in amd64 arm64; do
	name="rostalk-server_${VERSION}_linux_${arch}"
	echo "building $name"
	(
		cd "$ROOT/server"
		CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$GO" build -trimpath \
			-ldflags "$LDFLAGS" -o "$DIST/$name" ./cmd/rostalk-server
	)
done

cp "$INSTALL_SH" "$DIST/install.sh"
cp "$PUB_PEM" "$DIST/release.pub"
chmod 0755 "$DIST/install.sh"

cat >"$DIST/release.json" <<EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "built_at": "$BUILT_AT",
  "goos": "linux",
  "assets": {
    "amd64": "rostalk-server_${VERSION}_linux_amd64",
    "arm64": "rostalk-server_${VERSION}_linux_arm64"
  }
}
EOF

# SHA256SUMS covers every downloadable file, so the signature protects the
# installer and the public key copy as well as the binaries.
(
	cd "$DIST"
	sha256sum rostalk-server_* install.sh release.pub >SHA256SUMS
)

if [ "$UNSIGNED" -eq 0 ]; then
	echo "signing SHA256SUMS"
	(
		cd "$ROOT/server"
		"$GO" run ./cmd/rostalk-sign sign --key "$KEY" -o "$DIST/SHA256SUMS.sig" "$DIST/SHA256SUMS"
	)
	(
		cd "$ROOT/server"
		"$GO" run ./cmd/rostalk-sign verify --pubkey "$DIST/release.pub" \
			"$DIST/SHA256SUMS.sig" "$DIST/SHA256SUMS"
	)
fi

echo
echo "release $VERSION is in $DIST:"
ls -l "$DIST"
echo
echo "Publish the whole directory (for example behind HTTPS) and install with:"
echo "  curl -fsSL https://<your-host>/release/install.sh | sudo sh -s -- --base-url https://<your-host>/release"
