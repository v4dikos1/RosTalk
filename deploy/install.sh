#!/bin/sh
# rostalk-server installer for Linux.
#
# From the latest GitHub release (P13, ADR 0026):
#
#   curl -fsSL https://github.com/v4dikos1/RosTalk/releases/latest/download/install.sh | sudo sh
#
# (`make release RELEASE_REPO=owner/name` writes its repository into the copy
# published with the release), or from any other directory of release files:
#
#   curl -fsSL https://example.net/rostalk/install.sh | sudo sh -s -- \
#       --base-url https://example.net/rostalk
#
# or, from a directory with a locally built binary:
#
#   sudo sh deploy/install.sh --from-file dist/rostalk-server_1.2.3_linux_amd64
#
# It verifies the SHA256SUMS signature with the release public key embedded
# below, installs the binary, creates the service user and a hardened systemd
# unit, prints the firewall rules it did not change and starts the server.
# Running it again upgrades the binary and the unit; the data directory is
# never touched (except for the one-time data-directory permissions).
#
# This file is POSIX sh on purpose: ubuntu, debian and fedora minimal images have
# no bash guarantee. See docs/INSTALL.md.

set -eu

# --------------------------------------------------------------- defaults ---

# Public half of the release signing key, base64 DER. deploy/release.pub holds
# the same key; deploy/release.sh refuses to build a release when these differ.
RELEASE_PUBKEY_PEM='MCowBQYDK2VwAyEA8Dp673Q0lj2oVoVWU/ZtYNOlnqMSPq8ETppbc7tasbc='
RELEASE_PUBKEY_FINGERPRINT='beff7704aba5a4621414e2bb8b162d4bb3590c7b46e9892b73f7758f760ac2cd'

SERVICE=rostalk-server
UNIT=/etc/systemd/system/$SERVICE.service
DEFAULT_DATA=/var/lib/rostalk
DEFAULT_BIN=/usr/local/bin/rostalk-server

BASE_URL=${ROSTALK_RELEASE_BASE:-}
# GitHub repository of the official releases, owner/name. Used only when no
# --base-url is given; deploy/release-all.sh writes the release's repository
# into this default.
RELEASE_REPO=${ROSTALK_RELEASE_REPO:-v4dikos1/RosTalk}
VERSION=${ROSTALK_VERSION:-}
FROM_FILE=
SUMS=
PUBKEY=
INSECURE=0
PREVERIFIED=0
DATA=$DEFAULT_DATA
LOG_FILE=${ROSTALK_LOG_FILE-__default__}
SVC_USER=${ROSTALK_USER:-rostalk}
BIN=$DEFAULT_BIN
DOMAIN=
PUBLIC_HOST=${ROSTALK_PUBLIC_HOST:-}
ADVERTISE_IP=${ROSTALK_ADVERTISE_IP:-}
NAT=${ROSTALK_NAT:-off}
LISTEN=${ROSTALK_LISTEN:-:7443}
NO_SYSTEMD=0
NO_START=0

# Which settings were given explicitly (command line or environment). During a
# migration from Hearth these win over the old unit; everything else is
# inherited so the upgrade keeps the domain, port and media address.
DOMAIN_SET=0
PUBLIC_HOST_SET=0
ADVERTISE_IP_SET=0
NAT_SET=0
LISTEN_SET=0
LOG_FILE_SET=0
if [ -n "$PUBLIC_HOST" ]; then PUBLIC_HOST_SET=1; fi
if [ -n "$ADVERTISE_IP" ]; then ADVERTISE_IP_SET=1; fi
if [ -n "${ROSTALK_NAT:-}" ]; then NAT_SET=1; fi
if [ -n "${ROSTALK_LISTEN:-}" ]; then LISTEN_SET=1; fi
if [ -n "${ROSTALK_LOG_FILE+set}" ]; then LOG_FILE_SET=1; fi

usage() {
	cat <<'EOF'
rostalk-server installer

Usage: install.sh [options]

  --base-url URL      directory with release artefacts (https:// or file://);
                      default: the GitHub release of --repo
  --repo OWNER/NAME   GitHub repository of the releases (default: built in)
  --version VER       release version (default: the latest release, or the
                      only one in SHA256SUMS of --base-url)
  --from-file PATH    install this local binary instead of downloading
  --sums PATH         SHA256SUMS for --from-file (enables verification)
  --pubkey FILE|KEY   release public key (default: embedded key)
  --insecure          skip the signature check (local testing only)
  --preverified-signature  the client already verified Ed25519; allows a
                      checksum-only fallback when OpenSSL lacks -rawin
  --data DIR          data directory (default /var/lib/rostalk)
  --user NAME         service user (default rostalk)
  --binary PATH       binary path (default /usr/local/bin/rostalk-server)
  --domain DOMAIN     obtain a Let's Encrypt certificate for DOMAIN
  --public-host HOST  host used in invite links (default: detected LAN IP)
  --advertise-ip IP   public IP the media backend announces (1:1 NAT VPS)
  --nat MODE          port forwarding: off, auto, upnp or pmp (default off)
  --listen ADDR       control plane listen address (default :7443)
  --log-file PATH     size-rotated log file (default <data>/logs/rostalk-server.log;
                      pass an empty value to log to the journal only)
  --no-systemd        do not call systemctl (containers and tests)
  --no-start          install files and the unit, but do not start anything
  -h, --help          this text

Environment: ROSTALK_RELEASE_BASE, ROSTALK_RELEASE_REPO, ROSTALK_VERSION, ROSTALK_PUBLIC_HOST,
ROSTALK_ADVERTISE_IP, ROSTALK_NAT, ROSTALK_LISTEN, ROSTALK_USER, ROSTALK_LOG_FILE.
EOF
}

die() {
	echo "install.sh: $*" >&2
	exit 1
}

info() {
	echo "==> $*"
}

# ---------------------------------------------------------------- options ---

while [ $# -gt 0 ]; do
	case "$1" in
	--base-url) [ $# -ge 2 ] || die "--base-url needs a value"; BASE_URL=$2; shift 2 ;;
	--version) [ $# -ge 2 ] || die "--version needs a value"; VERSION=$2; shift 2 ;;
	--repo) [ $# -ge 2 ] || die "--repo needs a value"; RELEASE_REPO=$2; shift 2 ;;
	--from-file) [ $# -ge 2 ] || die "--from-file needs a value"; FROM_FILE=$2; shift 2 ;;
	--sums) [ $# -ge 2 ] || die "--sums needs a value"; SUMS=$2; shift 2 ;;
	--pubkey) [ $# -ge 2 ] || die "--pubkey needs a value"; PUBKEY=$2; shift 2 ;;
	--insecure) INSECURE=1; shift ;;
	--preverified-signature) PREVERIFIED=1; shift ;;
	--data) [ $# -ge 2 ] || die "--data needs a value"; DATA=$2; shift 2 ;;
	--user) [ $# -ge 2 ] || die "--user needs a value"; SVC_USER=$2; shift 2 ;;
	--binary) [ $# -ge 2 ] || die "--binary needs a value"; BIN=$2; shift 2 ;;
	--domain) [ $# -ge 2 ] || die "--domain needs a value"; DOMAIN=$2; DOMAIN_SET=1; shift 2 ;;
	--domain=*) DOMAIN=${1#--domain=}; DOMAIN_SET=1; shift ;;
	--public-host) [ $# -ge 2 ] || die "--public-host needs a value"; PUBLIC_HOST=$2; PUBLIC_HOST_SET=1; shift 2 ;;
	--public-host=*) PUBLIC_HOST=${1#--public-host=}; PUBLIC_HOST_SET=1; shift ;;
	--advertise-ip) [ $# -ge 2 ] || die "--advertise-ip needs a value"; ADVERTISE_IP=$2; ADVERTISE_IP_SET=1; shift 2 ;;
	--advertise-ip=*) ADVERTISE_IP=${1#--advertise-ip=}; ADVERTISE_IP_SET=1; shift ;;
	--nat) [ $# -ge 2 ] || die "--nat needs a value"; NAT=$2; NAT_SET=1; shift 2 ;;
	--nat=*) NAT=${1#--nat=}; NAT_SET=1; shift ;;
	--listen) [ $# -ge 2 ] || die "--listen needs a value"; LISTEN=$2; LISTEN_SET=1; shift 2 ;;
	--listen=*) LISTEN=${1#--listen=}; LISTEN_SET=1; shift ;;
	--log-file) [ $# -ge 2 ] || die "--log-file needs a value (use --log-file= for the journal only)"; LOG_FILE=$2; LOG_FILE_SET=1; shift 2 ;;
	--log-file=*) LOG_FILE=${1#--log-file=}; LOG_FILE_SET=1; shift ;;
	--no-systemd) NO_SYSTEMD=1; shift ;;
	--no-start) NO_START=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown argument $1 (see --help)" ;;
	esac
done

# ------------------------------------------------------------ preconditions ---

[ "$(uname -s)" = "Linux" ] || die "rostalk-server runs only on Linux"
case "$(uname -m)" in
x86_64 | amd64) ARCH=amd64 ;;
aarch64 | arm64) ARCH=arm64 ;;
*) die "unsupported architecture $(uname -m); releases exist for x86_64 and aarch64" ;;
esac

if [ "$(id -u)" -ne 0 ]; then
	die "run as root: curl ... | sudo sh -s -- ..."
fi

case "$NAT" in off | auto | upnp | pmp) ;; *) die "--nat must be off, auto, upnp or pmp" ;; esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/rostalk-install.XXXXXX")

# ------------------------------------------------- legacy Hearth install ---
# Servers installed before the RosTalk rename (ADR 0033) live under
# /var/lib/hearth with a hearth-server unit. The data is moved in place; the
# old binary and unit stay as *.hearth-old for a manual rollback.
LEGACY_SERVICE=hearth-server
LEGACY_UNIT=/etc/systemd/system/$LEGACY_SERVICE.service
LEGACY_DATA=/var/lib/hearth
LEGACY_BIN=/usr/local/bin/hearth-server
MIGRATION_ACTIVE=0
LEGACY_WAS_ACTIVE=0
LEGACY_WAS_ENABLED=0
DATA_HANDOVER_STARTED=0
LEGACY_OWNER=
LEGACY_GROUP=
ROLLBACK_FAILED=0

# A failure after the data directory has been moved must not leave a half
# migrated install: put the data, the unit and the binary back and re-enable
# the old service. The next run then starts from a working Hearth server and
# can migrate again.
rollback_migration() {
	[ "$MIGRATION_ACTIVE" -eq 1 ] || return 0
	MIGRATION_ACTIVE=0
	ROLLBACK_FAILED=0
	echo "install.sh: the migration from Hearth did not finish; restoring the previous installation" >&2
	if [ -d "$DATA" ] && [ ! -e "$LEGACY_DATA" ]; then
		if ! mv "$DATA" "$LEGACY_DATA"; then
			echo "install.sh: ERROR: could not move $DATA back to $LEGACY_DATA; the data was left at $DATA for the next run" >&2
			ROLLBACK_FAILED=1
		fi
	fi
	# If the handover to the new user had started, give the files back to the
	# user and group the old unit actually ran as, so the restored server can
	# read its 0600 keys. This is not always `hearth`: the old installer
	# accepted --user.
	if [ "$DATA_HANDOVER_STARTED" -eq 1 ] && [ -d "$LEGACY_DATA" ]; then
		if [ -z "$LEGACY_OWNER" ] || [ -z "$LEGACY_GROUP" ]; then
			echo "install.sh: ERROR: the previous owner of $LEGACY_DATA is unknown; run chown -R <user>:<group> $LEGACY_DATA before starting $LEGACY_SERVICE" >&2
			ROLLBACK_FAILED=1
		elif ! chown -R "$LEGACY_OWNER:$LEGACY_GROUP" "$LEGACY_DATA"; then
			echo "install.sh: ERROR: could not restore owner $LEGACY_OWNER:$LEGACY_GROUP on $LEGACY_DATA (see the error above)" >&2
			echo "install.sh: the data is back at $LEGACY_DATA; fix the cause and either run chown -R $LEGACY_OWNER:$LEGACY_GROUP $LEGACY_DATA or run the installer again" >&2
			ROLLBACK_FAILED=1
		fi
	fi
	if [ -f "$LEGACY_UNIT.hearth-old" ] && [ ! -e "$LEGACY_UNIT" ]; then
		if ! mv -f "$LEGACY_UNIT.hearth-old" "$LEGACY_UNIT"; then
			echo "install.sh: ERROR: could not restore $LEGACY_UNIT; it remains at $LEGACY_UNIT.hearth-old" >&2
			ROLLBACK_FAILED=1
		fi
	fi
	if [ -f "$LEGACY_BIN.hearth-old" ] && [ ! -e "$LEGACY_BIN" ]; then
		if ! mv -f "$LEGACY_BIN.hearth-old" "$LEGACY_BIN"; then
			echo "install.sh: ERROR: could not restore $LEGACY_BIN; it remains at $LEGACY_BIN.hearth-old" >&2
			ROLLBACK_FAILED=1
		fi
	fi
	if [ "$ROLLBACK_FAILED" -eq 0 ] &&
		[ "$NO_SYSTEMD" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload >/dev/null 2>&1 || true
		if [ "$LEGACY_WAS_ENABLED" -eq 1 ]; then
			systemctl enable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
		fi
		if [ "$LEGACY_WAS_ACTIVE" -eq 1 ]; then
			systemctl start "$LEGACY_SERVICE" >/dev/null 2>&1 || true
		fi
	fi
	if [ "$ROLLBACK_FAILED" -eq 0 ]; then
		rm -f "$MIGRATION_MARKER" 2>/dev/null || true
		echo "install.sh: Hearth files and the service are back in place. Fix the error above and run the installer again." >&2
	else
		echo "install.sh: the automatic restore did not finish; $DATA and $LEGACY_DATA were left in place, and the next run will continue the migration" >&2
	fi
}

cleanup() {
	rollback_migration
	rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

fetch() { # url destination
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 --connect-timeout 15 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die "curl or wget is required"
	fi
}

# ------------------------------------------------------------- public key ---

PUB_PEM=$TMP/release.pub
if [ -n "$PUBKEY" ]; then
	if [ -f "$PUBKEY" ]; then
		cp "$PUBKEY" "$PUB_PEM"
	else
		# Accept a pasted base64 DER key as well as PEM.
		case "$PUBKEY" in
		-----BEGIN*)
			printf '%s\n' "$PUBKEY" >"$PUB_PEM"
			;;
		*)
			printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$PUBKEY" >"$PUB_PEM"
			;;
		esac
	fi
else
	printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' \
		"$RELEASE_PUBKEY_PEM" >"$PUB_PEM"
fi

verify_signature() { # file-with-checksums signature
	if [ "$INSECURE" -eq 1 ]; then
		return 0
	fi
	command -v openssl >/dev/null 2>&1 ||
		die "openssl is required to verify the release signature; install it or pass --insecure (not recommended)"

	if verify_output=$(openssl pkeyutl -verify -pubin -inkey "$PUB_PEM" -rawin \
		-in "$1" -sigfile "$2" 2>&1); then
		info "release signature OK (key $RELEASE_PUBKEY_FINGERPRINT)"
		return 0
	fi

	# OpenSSL 1.1.1 (AlmaLinux 8, some Debian 11 hosts) has no `-rawin`.
	# The desktop client verifies the same signature with ring before upload,
	# so checksum-only is safe there — but never silently.
	openssl_major=$(openssl version 2>/dev/null | awk '{print $2}' | cut -d. -f1)
	case "$openssl_major" in
	'' | *[!0-9]*) openssl_major=999 ;;
	esac
	if [ "$openssl_major" -lt 3 ]; then
		if [ "$PREVERIFIED" -eq 1 ]; then
			echo "install.sh: WARNING: OpenSSL $openssl_major.x does not support pkeyutl -rawin." >&2
			echo "install.sh: the Ed25519 signature was verified by the RosTalk client before upload; continuing with SHA-256 verification." >&2
			info "release signature OK (verified by the client; this OpenSSL cannot check -rawin here)"
			return 0
		fi
		die "this OpenSSL cannot verify Ed25519 signatures (pkeyutl -rawin is missing). Run the installation from the RosTalk client, or update OpenSSL to 3.x."
	fi

	case "$verify_output" in
	*"unknown option"* | *"Unknown option"* | *"Option unknown"* | *"rawin"*)
		if [ "$PREVERIFIED" -eq 1 ]; then
			echo "install.sh: WARNING: this OpenSSL does not support pkeyutl -rawin." >&2
			echo "install.sh: the Ed25519 signature was verified by the RosTalk client before upload; continuing with SHA-256 verification." >&2
			info "release signature OK (verified by the client; OpenSSL 1.1.1 cannot check -rawin here)"
			return 0
		fi
		die "this OpenSSL cannot verify Ed25519 signatures (pkeyutl -rawin is missing). Run the installation from the RosTalk client, or update OpenSSL to 3.x."
		;;
	*)
		die "the release signature is not valid for this public key (fingerprint $RELEASE_PUBKEY_FINGERPRINT). Refusing to install. $verify_output"
		;;
	esac
}

# -------------------------------------------------------------- obtain bin ---

BIN_TMP=$TMP/rostalk-server
ASSET_NAME=

if [ -n "$FROM_FILE" ]; then
	[ -f "$FROM_FILE" ] || die "$FROM_FILE does not exist"
	cp "$FROM_FILE" "$BIN_TMP"
	chmod 0755 "$BIN_TMP"
	ASSET_NAME=$(basename "$FROM_FILE")
	info "using the local binary $FROM_FILE (sha256 $(sha256_of "$BIN_TMP"))"
	if [ -n "$SUMS" ]; then
		[ -f "$SUMS" ] || die "$SUMS does not exist"
		VERIFY_SUMS=$TMP/SHA256SUMS
		cp "$SUMS" "$VERIFY_SUMS"
		if [ -f "$SUMS.sig" ]; then
			verify_signature "$VERIFY_SUMS" "$SUMS.sig"
		fi
		want=$(awk -v n="$ASSET_NAME" '{ name=$2; sub(/^\*/, "", name); if (name == n) { print $1; exit } }' "$VERIFY_SUMS")
		[ -n "$want" ] || die "$ASSET_NAME is not listed in $SUMS"
		[ "$want" = "$(sha256_of "$BIN_TMP")" ] || die "checksum mismatch for $ASSET_NAME"
		info "checksum verified"
	fi
else
	if [ -z "$BASE_URL" ]; then
		# The Ed25519 signature below is the trust anchor, not the host:
		# GitHub only serves the files (ADR 0026).
		case "$RELEASE_REPO" in
		*[!A-Za-z0-9._/-]* | */*/* | /* | */ | *..*) die "--repo must be owner/name, got $RELEASE_REPO" ;;
		?*/?*) ;;
		*) die "--repo must be owner/name, got $RELEASE_REPO" ;;
		esac
		if [ -n "$VERSION" ]; then
			BASE_URL="https://github.com/$RELEASE_REPO/releases/download/v$VERSION"
		else
			BASE_URL="https://github.com/$RELEASE_REPO/releases/latest/download"
		fi
	fi
	BASE_URL=${BASE_URL%/}

	info "downloading release metadata from $BASE_URL"
	fetch "$BASE_URL/SHA256SUMS" "$TMP/SHA256SUMS" || die "cannot download $BASE_URL/SHA256SUMS"
	fetch "$BASE_URL/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" ||
		die "cannot download $BASE_URL/SHA256SUMS.sig (unsigned releases are not installable)"
	verify_signature "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig"

	if [ -z "$VERSION" ]; then
		ASSET_NAME=$(awk -v a="_linux_${ARCH}" '{ name=$2; sub(/^\*/, "", name); if (name ~ "^rostalk-server_.*" a "$") { print name; exit } }' "$TMP/SHA256SUMS")
		[ -n "$ASSET_NAME" ] || die "SHA256SUMS contains no rostalk-server binary for linux/$ARCH"
		VERSION=${ASSET_NAME#rostalk-server_}
		VERSION=${VERSION%_linux_$ARCH}
	else
		ASSET_NAME=rostalk-server_${VERSION}_linux_${ARCH}
	fi

	info "downloading $ASSET_NAME"
	fetch "$BASE_URL/$ASSET_NAME" "$BIN_TMP" || die "cannot download $BASE_URL/$ASSET_NAME"
	want=$(awk -v n="$ASSET_NAME" '{ name=$2; sub(/^\*/, "", name); if (name == n) { print $1; exit } }' "$TMP/SHA256SUMS")
	[ -n "$want" ] || die "$ASSET_NAME is not listed in SHA256SUMS"
	[ "$want" = "$(sha256_of "$BIN_TMP")" ] || die "checksum mismatch for $ASSET_NAME"
	chmod 0755 "$BIN_TMP"
	info "checksum verified for $ASSET_NAME"
fi

# ------------------------------------------------- migration from Hearth ---
# Move the data once, in place: the identity, TLS material, users and channels
# are kept, so every client and invite link keeps working. The server renames
# hearth.db itself on start. The old binary and unit stay as *.hearth-old for a
# manual rollback.
#
# The old unit may carry a domain, a non-default port and a media address
# (ADR 0017). They are read from ExecStart as plain text, never evaluated, and
# carried into the new unit unless the update passes them explicitly.
MIGRATION_MARKER=/var/lib/rostalk.migration
MIGRATED=0
KEPT_SETTINGS=
UNIT_SOURCE=
UNIT_EXPECTED_DATA=

unit_unsupported() { # token or explanation
	cat >&2 <<EOF
install.sh: cannot carry the service settings over automatically.
  ${UNIT_SOURCE:-$UNIT} contains "$1", which this installer does not understand.
The old service is still running and its data has not been moved.
Pass the settings explicitly and run the installer again, for example:
  sh install.sh ... --domain=<domain> --listen=<addr:port> --advertise-ip=<ip> --public-host=<host> --nat=<off|auto|upnp|pmp>
Carried automatically: --data, --listen, --public-host, --advertise-ip,
--domain, --nat and --log-file.
EOF
	exit 1
}

unit_value() { # option value
	[ -n "$2" ] || unit_unsupported "$1 with an empty value"
	if [ -n "$(printf '%s' "$2" | tr -d 'A-Za-z0-9.:/[]_-')" ]; then
		unit_unsupported "$1=$2"
	fi
}

parse_unit() { # unit file, data directory it was installed with
	[ -f "$1" ] || return 0
	UNIT_SOURCE=$1
	UNIT_EXPECTED_DATA=$2
	unit_line=$(sed -n 's/^[[:space:]]*ExecStart=[[:space:]]*//p' "$1" | sed -n '1p')
	[ -n "$unit_line" ] || unit_unsupported "an ExecStart line without a command"
	# Word splitting is intended: the unit lists arguments separated by spaces.
	# Globbing is not: a value with a wildcard must reach validation unchanged.
	set -f
	set -- $unit_line
	set +f
	shift
	if [ "${1:-}" = run ]; then
		shift
	fi
	while [ $# -gt 0 ]; do
		case "$1" in
		--*=*) name=${1%%=*}; value=${1#*=}; shift ;;
		--*) name=$1; [ $# -ge 2 ] || unit_unsupported "$1 without a value"; value=$2; shift 2 ;;
		*) unit_unsupported "$1" ;;
		esac
		case "$name" in
		--data)
			unit_value "$name" "$value"
			[ "$value" = "$UNIT_EXPECTED_DATA" ] || unit_unsupported "--data=$value (the data directory cannot be moved automatically)"
			;;
		--listen)
			unit_value "$name" "$value"
			if [ "$LISTEN_SET" -eq 0 ]; then LISTEN=$value; KEPT_SETTINGS="$KEPT_SETTINGS --listen=$value"; fi
			;;
		--public-host)
			unit_value "$name" "$value"
			if [ "$PUBLIC_HOST_SET" -eq 0 ]; then PUBLIC_HOST=$value; KEPT_SETTINGS="$KEPT_SETTINGS --public-host=$value"; fi
			;;
		--advertise-ip)
			unit_value "$name" "$value"
			if [ "$ADVERTISE_IP_SET" -eq 0 ]; then ADVERTISE_IP=$value; KEPT_SETTINGS="$KEPT_SETTINGS --advertise-ip=$value"; fi
			;;
		--domain)
			unit_value "$name" "$value"
			if [ "$DOMAIN_SET" -eq 0 ]; then DOMAIN=$value; KEPT_SETTINGS="$KEPT_SETTINGS --domain=$value"; fi
			;;
		--nat)
			unit_value "$name" "$value"
			case "$value" in off | auto | upnp | pmp) ;; *) unit_unsupported "--nat=$value" ;; esac
			if [ "$NAT_SET" -eq 0 ]; then NAT=$value; KEPT_SETTINGS="$KEPT_SETTINGS --nat=$value"; fi
			;;
		--log-file)
			unit_value "$name" "$value"
			case "$value" in
			"$UNIT_EXPECTED_DATA"/*) value=$DATA/${value#"$UNIT_EXPECTED_DATA"/} ;;
			*)
				echo "install.sh: the log file $value is outside $UNIT_EXPECTED_DATA; using the default log file instead" >&2
				continue
				;;
			esac
			if [ "$LOG_FILE_SET" -eq 0 ]; then LOG_FILE=$value; KEPT_SETTINGS="$KEPT_SETTINGS --log-file=$value"; fi
			;;
		*) unit_unsupported "$name" ;;
		esac
	done
}

# The owner and group the old service actually ran as. The unit is the source
# of truth (the old installer allowed --user); the data directory is a fallback
# when the unit has no User=/Group=. Read as text, never evaluated.
read_legacy_identity() {
	LEGACY_OWNER=
	LEGACY_GROUP=
	if [ -f "$LEGACY_UNIT" ]; then
		owner=$(sed -n 's/^[[:space:]]*User=[[:space:]]*//p' "$LEGACY_UNIT" | sed -n '1p')
		group=$(sed -n 's/^[[:space:]]*Group=[[:space:]]*//p' "$LEGACY_UNIT" | sed -n '1p')
		case "$owner" in
		'' | *[!A-Za-z0-9._-]*) ;;
		*) LEGACY_OWNER=$owner ;;
		esac
		case "$group" in
		'' | *[!A-Za-z0-9._-]*) ;;
		*) LEGACY_GROUP=$group ;;
		esac
	fi
	if [ -d "$LEGACY_DATA" ]; then
		if [ -z "$LEGACY_OWNER" ]; then
			LEGACY_OWNER=$(stat -c %U "$LEGACY_DATA" 2>/dev/null || true)
		fi
		if [ -z "$LEGACY_GROUP" ]; then
			LEGACY_GROUP=$(stat -c %G "$LEGACY_DATA" 2>/dev/null || true)
		fi
	fi
	if [ -z "$LEGACY_OWNER" ] || [ -z "$LEGACY_GROUP" ]; then
		echo "install.sh: WARNING: cannot determine the owner and group of the Hearth data; a rollback will ask for a manual chown" >&2
	fi
}

stop_legacy_service() {
	if [ "$NO_SYSTEMD" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
		if systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null; then
			LEGACY_WAS_ACTIVE=1
			systemctl stop "$LEGACY_SERVICE"
		fi
		if systemctl is-enabled --quiet "$LEGACY_SERVICE" 2>/dev/null; then
			LEGACY_WAS_ENABLED=1
			systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
		fi
	fi
}

park_legacy_files() {
	if [ -f "$LEGACY_UNIT" ]; then
		mv -f "$LEGACY_UNIT" "$LEGACY_UNIT.hearth-old"
	fi
	if [ -f "$LEGACY_BIN" ]; then
		mv -f "$LEGACY_BIN" "$LEGACY_BIN.hearth-old"
	fi
}

if [ "$DATA" = "$DEFAULT_DATA" ] && [ -d "$LEGACY_DATA" ] && [ ! -e "$DATA" ]; then
	info "found a server installed as Hearth: moving $LEGACY_DATA to $DATA"
	parse_unit "$LEGACY_UNIT" "$LEGACY_DATA"
	read_legacy_identity
	# The marker survives a hard kill. A repeated run sees it and finishes the
	# move instead of treating the half-migrated directory as a normal install.
	: >"$MIGRATION_MARKER" || die "cannot write $MIGRATION_MARKER; the Hearth installation was not changed"
	MIGRATION_ACTIVE=1
	stop_legacy_service
	mv "$LEGACY_DATA" "$DATA"
	park_legacy_files
	MIGRATED=1
elif [ "$DATA" = "$DEFAULT_DATA" ] && [ -e "$MIGRATION_MARKER" ] && [ -d "$DATA" ] && [ ! -e "$LEGACY_DATA" ]; then
	info "completing an interrupted migration from Hearth"
	if [ -f "$LEGACY_UNIT" ]; then
		parse_unit "$LEGACY_UNIT" "$LEGACY_DATA"
	elif [ -f "$LEGACY_UNIT.hearth-old" ]; then
		parse_unit "$LEGACY_UNIT.hearth-old" "$LEGACY_DATA"
	fi
	stop_legacy_service
	park_legacy_files
	MIGRATED=1
fi
# A second install of an existing RosTalk server must keep its domain, port and
# media address too. The current unit is read the same way; explicit command
# line or environment values still win.
if [ "$MIGRATED" -eq 0 ] && [ "$DATA" = "$DEFAULT_DATA" ] && [ -f "$UNIT" ]; then
	parse_unit "$UNIT" "$DATA"
fi
if [ -n "$KEPT_SETTINGS" ]; then
	if [ "$MIGRATED" -eq 1 ]; then
		info "keeping the Hearth service settings:$KEPT_SETTINGS"
	else
		info "keeping the current service settings:$KEPT_SETTINGS"
	fi
fi

# ------------------------------------------------------------- user and data ---

if ! id -u "$SVC_USER" >/dev/null 2>&1; then
	info "creating the system user $SVC_USER"
	NOLOGIN=$(command -v nologin 2>/dev/null || echo /usr/sbin/nologin)
	if command -v useradd >/dev/null 2>&1; then
		useradd --system --home-dir "$DATA" --shell "$NOLOGIN" --user-group "$SVC_USER" 2>/dev/null ||
			useradd -r -d "$DATA" -s "$NOLOGIN" "$SVC_USER" ||
			die "could not create the service user $SVC_USER"
	else
		die "useradd is required to create the service user"
	fi
fi
GROUP=$(id -gn "$SVC_USER")

if [ "$LOG_FILE" = "__default__" ]; then
	LOG_FILE=$DATA/logs/rostalk-server.log
fi

if [ ! -d "$DATA" ]; then
	info "creating the data directory $DATA"
	install -d -m 0750 -o "$SVC_USER" -g "$GROUP" "$DATA"
fi
chmod 0750 "$DATA"
# A previous run may have stopped after moving the directory but before the new
# user could take it over, or `useradd` may have failed. Always finish the
# handover, including nested 0600 key files whose mode must not change.
if [ -n "$(find "$DATA" ! -user "$SVC_USER" -print -quit 2>/dev/null)" ]; then
	info "handing $DATA over to $SVC_USER"
	DATA_HANDOVER_STARTED=1
	chown -R "$SVC_USER:$GROUP" "$DATA" ||
		die "could not change the owner of $DATA; the previous installation is preserved"
fi

if [ "$MIGRATED" -eq 1 ]; then
	info "moved the Hearth data; the old user 'hearth' can be removed with: userdel hearth"
fi
if [ -n "$LOG_FILE" ]; then
	install -d -m 0750 -o "$SVC_USER" -g "$GROUP" "$(dirname "$LOG_FILE")"
fi
# From here on the data belongs to the new installation; a failure no longer
# needs to restore Hearth. The marker stays until the new unit is started so a
# repeated run still reads the parked unit and keeps its settings.
MIGRATION_ACTIVE=0

# --------------------------------------------------------------- binary ---

WAS_ACTIVE=0
if [ -d /run/systemd/system ] && [ "$NO_SYSTEMD" -eq 0 ] && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
	WAS_ACTIVE=1
fi

info "installing $BIN"
install -d -m 0755 "$(dirname "$BIN")"
# Keep the previous binary and unit for the client's rollback. A fresh install
# has nothing to keep; an update leaves the last good files next to them.
if [ -f "$BIN" ]; then
	cp -p "$BIN" "$BIN.bak"
fi
if [ -f "$UNIT" ]; then
	cp -p "$UNIT" "$UNIT.bak"
fi
install -m 0755 "$BIN_TMP" "$BIN.new"
mv -f "$BIN.new" "$BIN"

# ---------------------------------------------------------------- public host ---

detect_lan_ip() {
	ip=""
	if command -v ip >/dev/null 2>&1; then
		ip=$(ip -4 route get 1.1.1.1 2>/dev/null |
			awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')
	fi
	if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
		ip=$(hostname -I 2>/dev/null | awk '{print $1}')
	fi
	printf '%s' "$ip"
}

EFFECTIVE_HOST=$PUBLIC_HOST
if [ -n "$DOMAIN" ]; then
	EFFECTIVE_HOST=$DOMAIN
elif [ -z "$EFFECTIVE_HOST" ]; then
	EFFECTIVE_HOST=$(detect_lan_ip)
fi

# ---------------------------------------------------------------- unit ---

info "writing $UNIT"
install -d -m 0755 "$(dirname "$UNIT")"
EXEC_ARGS="run --data=$DATA --listen=$LISTEN"
if [ -n "$EFFECTIVE_HOST" ]; then
	EXEC_ARGS="$EXEC_ARGS --public-host=$EFFECTIVE_HOST"
fi
if [ -n "$ADVERTISE_IP" ]; then
	EXEC_ARGS="$EXEC_ARGS --advertise-ip=$ADVERTISE_IP"
fi
if [ -n "$DOMAIN" ]; then
	EXEC_ARGS="$EXEC_ARGS --domain=$DOMAIN"
fi
if [ "$NAT" != off ]; then
	EXEC_ARGS="$EXEC_ARGS --nat=$NAT"
fi
if [ -n "$LOG_FILE" ]; then
	EXEC_ARGS="$EXEC_ARGS --log-file=$LOG_FILE"
fi

UNIT_TMP=$TMP/rostalk-server.service
cat >"$UNIT_TMP" <<EOF
[Unit]
Description=RosTalk voice server
Documentation=https://github.com/v4dikos1/RosTalk/blob/main/docs/INSTALL.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$GROUP
WorkingDirectory=$DATA
ExecStart=$BIN $EXEC_ARGS
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
LimitNOFILE=65535
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$UNIT_TMP" "$UNIT"

# ---------------------------------------------------------------- firewall ---

print_firewall() {
	PORTS_TCP="7443 7881"
	PORTS_UDP="7882"
	if [ -n "$DOMAIN" ]; then
		PORTS_TCP="80 443 7443 7881"
	fi
	if command -v ufw >/dev/null 2>&1; then
		echo "  ufw:      sudo ufw allow 7443/tcp && sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp"
		if [ -n "$DOMAIN" ]; then
			echo "            sudo ufw allow 80/tcp && sudo ufw allow 443/tcp"
		fi
	elif command -v firewall-cmd >/dev/null 2>&1; then
		echo "  firewalld: sudo firewall-cmd --permanent --add-port=7443/tcp --add-port=7881/tcp --add-port=7882/udp"
		if [ -n "$DOMAIN" ]; then
			echo "             sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp"
		fi
		echo "             sudo firewall-cmd --reload"
	else
		echo "  open TCP 7443 and 7881 and UDP 7882 in whatever firewall you use"
		if [ -n "$DOMAIN" ]; then
			echo "  (domain mode also needs TCP 80 and 443 for Let's Encrypt)"
		fi
	fi
	return 0
}

# ------------------------------------------------------------------ start ---

if [ "$NO_SYSTEMD" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
	systemctl daemon-reload
	if [ "$NO_START" -eq 0 ]; then
		if [ "$WAS_ACTIVE" -eq 1 ]; then
			info "restarting $SERVICE"
			systemctl restart "$SERVICE"
		else
			info "starting $SERVICE"
			systemctl enable --now "$SERVICE"
		fi
	fi
else
	info "systemd is not running here; the unit is written but not started"
fi

# The new unit now carries the settings from the old one; a later upgrade no
# longer needs the parked unit as its source.
if [ -e "$MIGRATION_MARKER" ]; then
	rm -f "$MIGRATION_MARKER" 2>/dev/null || true
fi

# ------------------------------------------------------------------- report ---

PORT=${LISTEN##*:}
if [ "$NO_START" -eq 0 ] && command -v systemctl >/dev/null 2>&1 && [ "$NO_SYSTEMD" -eq 0 ]; then
	if [ -n "$DOMAIN" ]; then
		HEALTH_ARGS="--data=$DATA --domain=$DOMAIN --url=https://$DOMAIN:$PORT/healthz"
	else
		HEALTH_ARGS="--data=$DATA --url=https://127.0.0.1:$PORT/healthz"
	fi
	i=0
	while [ $i -lt 30 ]; do
		if "$BIN" healthcheck $HEALTH_ARGS >/dev/null 2>&1; then
			break
		fi
		i=$((i + 1))
		sleep 1
	done
fi

LINK_ARGS="link --data=$DATA --listen=$LISTEN"
if [ -n "$EFFECTIVE_HOST" ]; then
	LINK_ARGS="$LINK_ARGS --public-host=$EFFECTIVE_HOST"
fi
if [ -n "$ADVERTISE_IP" ]; then
	LINK_ARGS="$LINK_ARGS --advertise-ip=$ADVERTISE_IP"
fi
if [ -n "$DOMAIN" ]; then
	LINK_ARGS="$LINK_ARGS --domain=$DOMAIN"
fi

echo
echo "RosTalk server installed:"
echo "  binary: $BIN"
echo "  data:   $DATA"
echo "  unit:   $SERVICE"
if [ -n "$EFFECTIVE_HOST" ]; then
	echo "  host:   $EFFECTIVE_HOST"
fi
echo
echo "Open these ports in your firewall and in the provider panel:"
print_firewall
echo
if [ -f "$DATA/admin-invite" ]; then
	if ADMIN_LINK=$("$BIN" $LINK_ARGS 2>/dev/null); then
		echo "First start: administrator invite (single use, becomes invalid once used):"
		echo
		echo "  $ADMIN_LINK"
		echo
		echo "Whoever opens this link becomes an administrator."
	else
		echo "The server created an administrator invite; show it with:"
		echo "  $BIN $LINK_ARGS"
	fi
else
	if [ -f "$DATA/rostalk.db" ]; then
		echo "An administrator already exists. Create a normal invite with:"
		echo "  $BIN invite --data $DATA --public-host ${EFFECTIVE_HOST:-<host>}"
	else
		echo "The server has not run yet. Start it and read the administrator invite:"
		echo "  systemctl start $SERVICE"
		echo "  journalctl -u $SERVICE -o cat | grep rostalk://join"
	fi
fi
echo
echo "Status and logs:"
echo "  systemctl status $SERVICE"
echo "  journalctl -u $SERVICE -f"
echo "Diagnostics:"
echo "  $BIN doctor --data $DATA"
