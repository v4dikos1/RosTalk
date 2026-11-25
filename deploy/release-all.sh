#!/bin/sh
# Build the whole RosTalk release into dist/release-<version> (P13, ADR 0026).
#
#   make release VERSION=0.2.0 [RELEASE_REPO=owner/name]
#
# There is no hosted CI (ADR 0015): this script is the release pipeline and
# runs on the Windows build machine (MSVC, Git for Windows, Go, Node). It
# produces exactly the files of a GitHub release:
#
#   RosTalk-Setup-<v>.exe               client installer (NSIS, per user)
#   RosTalk-<v>-portable.zip            rostalk.exe + README, nothing installed
#   RosTalk-Server-Setup-<v>.zip        rostalk-server-setup.exe + server/ bundle
#   rostalk-server_<v>_linux_amd64      server binaries for install.sh
#   rostalk-server_<v>_linux_arm64
#   install.sh                         Linux installer, defaults to this repo
#   latest.json                        manifest for the client updater
#   SHA256SUMS, SHA256SUMS.sig         checksums of every file above, Ed25519
#
# Keys never enter the repository or the log:
#   ROSTALK_SIGN_KEY             Ed25519 release key (server, SHA256SUMS);
#                               default %USERPROFILE%/.rostalk/release/rostalk-release.key
#   TAURI_SIGNING_PRIVATE_KEY   minisign updater key (path or content);
#                               default %USERPROFILE%/.rostalk/release/rostalk-updater.key
#   (keys made before the RosTalk rename are still found under
#   %USERPROFILE%/.hearth/release/hearth-*.key, ADR 0033)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   empty when unset
#
# Authenticode (optional; the release is built either way and the summary
# says "НЕ ПОДПИСАНО" when it is off). Set in the environment or in
# ROSTALK_SIGNING_ENV (default %USERPROFILE%/.rostalk/release/signing.env, a
# local file outside git):
#   ROSTALK_AUTHENTICODE_THUMBPRINT + ROSTALK_AUTHENTICODE_TIMESTAMP_URL
#       certificate in the Windows store (token/HSM CSP), signtool, SHA-256,
#       RFC 3161 timestamp;
#   or ROSTALK_AUTHENTICODE_COMMAND  a command with %1 for the file (cloud HSM,
#       Microsoft Artifact Signing, SignPath CLI); Tauri splits it on spaces.
#
# Other knobs: OUT (output directory), RELEASE_NOTES_FILE (notes for the
# manifest and gh), RELEASE_ALLOW_VERSION_MISMATCH=1 (build a version that is
# not written in tauri.conf.json/Cargo.toml — for local update tests only),
# RELEASE_SKIP_CLIENT=1 / RELEASE_SKIP_SETUP=1 (reuse existing builds; debug).

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${RELEASE_VERSION:-${VERSION:-}}
REPO=${ROSTALK_RELEASE_REPO:-v4dikos1/RosTalk}
NPM=${NPM:-npm}
GO=${GO:-go}

die() {
	echo "release-all.sh: $*" >&2
	exit 1
}
step() {
	echo
	echo "==> $*"
}

# ------------------------------------------------------------- arguments ---

[ -n "$VERSION" ] || die "VERSION is required: make release VERSION=x.y.z"
case "$VERSION" in
*[!0-9A-Za-z.-]* | .* | *..*) die "VERSION must look like 1.2.3 or 1.2.3-rc.1, got $VERSION" ;;
[0-9]*.[0-9]*.[0-9]*) ;;
*) die "VERSION must look like 1.2.3 or 1.2.3-rc.1, got $VERSION" ;;
esac
case "$REPO" in
*[!A-Za-z0-9._/-]* | */*/* | /* | */ | *..*) die "RELEASE_REPO must be owner/name, got $REPO" ;;
?*/?*) ;;
*) die "RELEASE_REPO must be owner/name, got $REPO" ;;
esac
export ROSTALK_RELEASE_REPO="$REPO"

case "$(uname -s)" in
MSYS* | MINGW* | CYGWIN*) ;;
*) die "the client is built on Windows only (MSVC); run this on the Windows build machine" ;;
esac

winpath() { cygpath -w "$1"; }

OUT=${OUT:-"$ROOT/dist/release-$VERSION"}
TAURI_DIR="$ROOT/client/src-tauri"
SETUP_DIR="$TAURI_DIR/apps/server-setup"
TARGET="$TAURI_DIR/target/release"
DOWNLOAD="https://github.com/$REPO/releases/download/v$VERSION"

if [ -e "$OUT" ]; then
	die "$OUT already exists; remove it first (a release is built into a clean directory)"
fi

# ------------------------------------------------------------- versions ---

json_version() { sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1" | head -n 1; }
cargo_version() { sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' "$1" | head -n 1; }

mismatch=
for pair in \
	"client/src-tauri/tauri.conf.json:$(json_version "$TAURI_DIR/tauri.conf.json")" \
	"client/src-tauri/Cargo.toml:$(cargo_version "$TAURI_DIR/Cargo.toml")" \
	"client/src-tauri/apps/server-setup/tauri.conf.json:$(json_version "$SETUP_DIR/tauri.conf.json")" \
	"client/src-tauri/apps/server-setup/Cargo.toml:$(cargo_version "$SETUP_DIR/Cargo.toml")"; do
	if [ "${pair##*:}" != "$VERSION" ]; then
		mismatch="$mismatch ${pair%%:*}=${pair##*:}"
	fi
done
if [ -n "$mismatch" ]; then
	if [ "${RELEASE_ALLOW_VERSION_MISMATCH:-0}" = "1" ]; then
		echo "release-all.sh: WARNING: building $VERSION while the sources say:$mismatch" >&2
		echo "  (RELEASE_ALLOW_VERSION_MISMATCH=1: local update tests only, never publish this)" >&2
	else
		die "the sources are not at $VERSION:$mismatch
  Bump the four versions, commit, tag v$VERSION, then run make release (docs/RELEASE.md)."
	fi
fi

# ----------------------------------------------------------------- keys ---

release_dir=$(cygpath -u "${USERPROFILE:-$HOME}/.rostalk/release")
legacy_release_dir=$(cygpath -u "${USERPROFILE:-$HOME}/.hearth/release")

if [ -z "${ROSTALK_SIGN_KEY:-}" ]; then
	for candidate in "$release_dir/rostalk-release.key" "$legacy_release_dir/hearth-release.key"; do
		if [ -f "$candidate" ]; then
			ROSTALK_SIGN_KEY=$candidate
			break
		fi
	done
fi
[ -n "${ROSTALK_SIGN_KEY:-}" ] && [ -f "$ROSTALK_SIGN_KEY" ] ||
	die "the Ed25519 release key is missing: set ROSTALK_SIGN_KEY (docs/RELEASE.md, section keys)"
export ROSTALK_SIGN_KEY

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
	updater_key="$release_dir/rostalk-updater.key"
	if [ ! -f "$updater_key" ] && [ -f "$legacy_release_dir/hearth-updater.key" ]; then
		updater_key="$legacy_release_dir/hearth-updater.key"
	fi
	[ -f "$updater_key" ] ||
		die "the updater key is missing: set TAURI_SIGNING_PRIVATE_KEY or create $updater_key (make release-key)"
	TAURI_SIGNING_PRIVATE_KEY=$(winpath "$updater_key")
fi
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ---------------------------------------------------------- authenticode ---

if [ -n "${ROSTALK_SIGNING_ENV:-}" ]; then
	signing_env=$(cygpath -u "$ROSTALK_SIGNING_ENV")
elif [ -f "$release_dir/signing.env" ] || [ ! -f "$legacy_release_dir/signing.env" ]; then
	signing_env="$release_dir/signing.env"
else
	signing_env="$legacy_release_dir/signing.env"
fi
if [ -f "$signing_env" ]; then
	# shellcheck disable=SC1090
	. "$signing_env"
	echo "release-all.sh: Authenticode settings read from $signing_env"
fi

SIGN_MODE=none
if [ -n "${ROSTALK_AUTHENTICODE_COMMAND:-}" ]; then
	case "$ROSTALK_AUTHENTICODE_COMMAND" in
	*%1*) SIGN_MODE=command ;;
	*) die "ROSTALK_AUTHENTICODE_COMMAND must contain %1 (the file to sign)" ;;
	esac
elif [ -n "${ROSTALK_AUTHENTICODE_THUMBPRINT:-}" ]; then
	[ -n "${ROSTALK_AUTHENTICODE_TIMESTAMP_URL:-}" ] ||
		die "ROSTALK_AUTHENTICODE_TIMESTAMP_URL (RFC 3161) is required with a thumbprint"
	case "$ROSTALK_AUTHENTICODE_THUMBPRINT" in
	*[!0-9A-Fa-f]*) die "ROSTALK_AUTHENTICODE_THUMBPRINT must be the SHA-1 hex of the certificate" ;;
	esac
	SIGN_MODE=thumbprint
fi

find_signtool() {
	if [ -n "${ROSTALK_SIGNTOOL:-}" ]; then
		printf '%s\n' "$ROSTALK_SIGNTOOL"
		return
	fi
	ls -d "/c/Program Files (x86)/Windows Kits/10/bin/"*/x64/signtool.exe 2>/dev/null | sort | tail -n 1
}

# Also used without signing settings, to report the state of the files.
SIGNTOOL=$(find_signtool || true)
if [ "$SIGN_MODE" = thumbprint ] && [ -z "$SIGNTOOL" ]; then
	die "signtool.exe was not found (Windows SDK); set ROSTALK_SIGNTOOL"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/rostalk-release.XXXXXX")
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# Tauri configuration overlay: the version of this release and, when
# configured, the Windows signing settings (bundle.windows, Tauri 2.12:
# certificateThumbprint/digestAlgorithm/timestampUrl/tsp or signCommand with
# %1). Tauri signs the client exe and the NSIS installer before it writes the
# updater signature.
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
case "$SIGN_MODE" in
thumbprint)
	signing_json=$(printf ', "bundle": { "windows": { "certificateThumbprint": "%s", "digestAlgorithm": "sha256", "timestampUrl": "%s", "tsp": true } }' \
		"$(json_escape "$ROSTALK_AUTHENTICODE_THUMBPRINT")" "$(json_escape "$ROSTALK_AUTHENTICODE_TIMESTAMP_URL")")
	;;
command)
	signing_json=$(printf ', "bundle": { "windows": { "signCommand": "%s" } }' "$(json_escape "$ROSTALK_AUTHENTICODE_COMMAND")")
	;;
*) signing_json= ;;
esac
printf '{ "version": "%s"%s }\n' "$VERSION" "$signing_json" >"$TMP/client.conf.json"
printf '{ "version": "%s" }\n' "$VERSION" >"$TMP/setup.conf.json"

# Signs one file that Tauri does not bundle (rostalk-server-setup.exe).
sign_file() {
	file_win=$(winpath "$1")
	case "$SIGN_MODE" in
	thumbprint)
		"$SIGNTOOL" sign /sha1 "$ROSTALK_AUTHENTICODE_THUMBPRINT" /fd sha256 \
			/tr "$ROSTALK_AUTHENTICODE_TIMESTAMP_URL" /td sha256 "$file_win" >/dev/null
		;;
	command)
		# Same splitting as Tauri: words separated by spaces, %1 replaced.
		set -f
		# shellcheck disable=SC2086
		set -- $ROSTALK_AUTHENTICODE_COMMAND
		set +f
		cmd=$1
		shift
		args=
		for word in "$@"; do
			[ "$word" = "%1" ] && word=$file_win
			args="$args$(printf '%s' "$word" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/") "
		done
		eval "\"\$cmd\" $args" >/dev/null
		;;
	esac
}

is_signed() {
	[ -n "$SIGNTOOL" ] || return 1
	"$SIGNTOOL" verify /pa /q "$(winpath "$1")" >/dev/null 2>&1
}

# ------------------------------------------------------------- server ---

step "server $VERSION for linux/amd64 and linux/arm64 (signed with the release key)"
sed "s|^RELEASE_REPO=\${ROSTALK_RELEASE_REPO:-[^}]*}|RELEASE_REPO=\${ROSTALK_RELEASE_REPO:-$REPO}|" \
	"$ROOT/deploy/install.sh" >"$TMP/install.sh"
grep -q "^RELEASE_REPO=\${ROSTALK_RELEASE_REPO:-$REPO}\$" "$TMP/install.sh" ||
	die "could not write the release repository into install.sh"
VERSION="$VERSION" DIST="$TMP/server" INSTALL_SH="$TMP/install.sh" GO="$GO" \
	sh "$ROOT/deploy/release.sh"

# ------------------------------------------------------------- client ---

if [ "${RELEASE_SKIP_CLIENT:-0}" != "1" ]; then
	step "client $VERSION: NSIS installer and updater signature"
	rm -rf "$TARGET/bundle/nsis"
	(
		cd "$ROOT/client"
		TAURI_APP_PATH=$(winpath "$TAURI_DIR") \
			"$NPM" --prefix ui exec -- tauri build --config "$(winpath "$TMP/client.conf.json")"
	)
fi
INSTALLER="$TARGET/bundle/nsis/RosTalk_${VERSION}_x64-setup.exe"
[ -f "$INSTALLER" ] || die "the installer was not produced: $INSTALLER"
[ -s "$INSTALLER.sig" ] || die "the updater signature was not produced: $INSTALLER.sig"
[ -f "$TARGET/rostalk.exe" ] || die "the client exe is missing: $TARGET/rostalk.exe"

if [ "${RELEASE_SKIP_SETUP:-0}" != "1" ]; then
	step "rostalk-server-setup $VERSION"
	(
		cd "$ROOT/client"
		TAURI_APP_PATH=$(winpath "$SETUP_DIR") \
			"$NPM" --prefix ui exec -- tauri build --no-bundle --config "$(winpath "$TMP/setup.conf.json")"
	)
fi
[ -f "$TARGET/rostalk-server-setup.exe" ] || die "rostalk-server-setup.exe was not produced"

# --------------------------------------------------------- authenticode ---

SIGNED_SUMMARY="НЕ ПОДПИСАНО (Authenticode): SmartScreen покажет «Неизвестный издатель»"
if [ "$SIGN_MODE" != none ]; then
	step "Authenticode ($SIGN_MODE)"
	cp "$TARGET/rostalk-server-setup.exe" "$TMP/rostalk-server-setup.exe"
	sign_file "$TMP/rostalk-server-setup.exe"
	if [ -n "$SIGNTOOL" ]; then
		for file in "$TARGET/rostalk.exe" "$INSTALLER" "$TMP/rostalk-server-setup.exe"; do
			is_signed "$file" || die "$(basename "$file") is not signed; check the signing settings"
			echo "  signed: $(basename "$file")"
		done
	else
		echo "  signtool not found: signatures were not verified here" >&2
	fi
	SIGNED_SUMMARY="Authenticode: подписано ($SIGN_MODE)"
else
	cp "$TARGET/rostalk-server-setup.exe" "$TMP/rostalk-server-setup.exe"
fi

# ------------------------------------------------------------- assemble ---

step "assembling $OUT"
mkdir -p "$OUT"

zip_dir() {
	# Windows PowerShell's Compress-Archive: no zip tool is needed.
	powershell.exe -NoProfile -NonInteractive -Command \
		"Compress-Archive -Path '$(winpath "$1")\\*' -DestinationPath '$(winpath "$2")' -CompressionLevel Optimal" ||
		die "could not write $2"
}

cp "$INSTALLER" "$OUT/RosTalk-Setup-$VERSION.exe"

EXE="$TARGET/rostalk.exe" OUT="$TMP/portable" sh "$ROOT/deploy/portable-client.sh" >/dev/null
zip_dir "$TMP/portable" "$OUT/RosTalk-$VERSION-portable.zip"

setup="$TMP/setup/RosTalk-Server-Setup-$VERSION"
mkdir -p "$setup/server"
cp "$TMP/rostalk-server-setup.exe" "$setup/rostalk-server-setup.exe"
cp "$TMP/server/"* "$setup/server/"
cat >"$setup/README.txt" <<EOF
RosTalk Server Setup $VERSION
=========================

Installs the RosTalk server on a Linux VPS (Ubuntu, Debian, Fedora, Alma/Rocky
Linux) over SSH. Run rostalk-server-setup.exe and keep the server folder next
to it: it holds the signed server release that is uploaded to the VPS.

At the end the program shows an admin invite link. Copy it, open the RosTalk
client, choose Connect and paste the link.

Ports the server needs: TCP 7443, TCP 7881, UDP 7882 (a domain also needs
TCP 80 and 443). Open them in the provider panel as well.

Without Windows, on the Linux server itself:
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sudo sh

Releases: https://github.com/$REPO/releases
EOF
zip_dir "$TMP/setup" "$OUT/RosTalk-Server-Setup-$VERSION.zip"

for arch in amd64 arm64; do
	cp "$TMP/server/rostalk-server_${VERSION}_linux_${arch}" "$OUT/"
done
cp "$TMP/install.sh" "$OUT/install.sh"

notes_file=${RELEASE_NOTES_FILE:-}
if [ -n "$notes_file" ]; then
	[ -f "$notes_file" ] || die "RELEASE_NOTES_FILE=$notes_file does not exist"
	notes=$(cat "$notes_file")
else
	notes="RosTalk $VERSION"
fi
signature=$(tr -d '\r\n' <"$INSTALLER.sig")
notes_json=$(printf '%s' "$notes" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }')
cat >"$OUT/latest.json" <<EOF
{
  "version": "$VERSION",
  "notes": "$notes_json",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "windows-x86_64": {
      "signature": "$signature",
      "url": "$DOWNLOAD/RosTalk-Setup-$VERSION.exe"
    }
  }
}
EOF

step "SHA256SUMS and its Ed25519 signature"
(
	cd "$OUT"
	sha256sum RosTalk-Setup-"$VERSION".exe RosTalk-"$VERSION"-portable.zip \
		RosTalk-Server-Setup-"$VERSION".zip rostalk-server_"$VERSION"_linux_amd64 \
		rostalk-server_"$VERSION"_linux_arm64 install.sh latest.json >SHA256SUMS
)
(
	cd "$ROOT/server"
	"$GO" run ./cmd/rostalk-sign sign --key "$ROSTALK_SIGN_KEY" -o "$OUT/SHA256SUMS.sig" "$OUT/SHA256SUMS"
	"$GO" run ./cmd/rostalk-sign verify --pubkey "$ROOT/deploy/release.pub" "$OUT/SHA256SUMS.sig" "$OUT/SHA256SUMS"
)
(cd "$OUT" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS does not match the files"

# Notes for `gh release create`, outside the release directory.
cat >"$OUT.notes.md" <<EOF
$notes

**Клиент для Windows:** \`RosTalk-Setup-$VERSION.exe\` (установка без прав администратора) или \`RosTalk-$VERSION-portable.zip\`.

**Свой сервер:** с Windows — \`RosTalk-Server-Setup-$VERSION.zip\` (ставит сервер на VPS по SSH); прямо на Linux:

\`\`\`
curl -fsSL https://github.com/$REPO/releases/download/v$VERSION/install.sh | sudo sh -s -- --version $VERSION
\`\`\`

Проверка файлов: \`SHA256SUMS\` (подпись Ed25519 — \`SHA256SUMS.sig\`, ключ — \`deploy/release.pub\`).

$SIGNED_SUMMARY.
EOF

echo
echo "release $VERSION for $REPO is in $OUT:"
ls -l "$OUT"
echo
echo "$SIGNED_SUMMARY"
echo "Next: check the files (docs/RELEASE.md, release checklist), then"
echo "  make publish-release VERSION=$VERSION RELEASE_REPO=$REPO DRY_RUN=1"
