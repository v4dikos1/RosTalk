#!/bin/sh
# Runs deploy/install.sh in clean ubuntu, debian and fedora containers.
#
#   sh deploy/test-install-docker.sh [dist-directory]
#
# The release directory must contain installer, binaries, SHA256SUMS and its
# signature (deploy/release.sh writes it). The test uses --from-url file://...
# inside the container, so no web server is needed, and --no-systemd because
# containers have no systemd. It covers the full path: signature, checksum,
# architecture, user, data directory, unit and a second run (upgrade).
#
# MIGRATION_ONLY=1 runs only the Hearth migration cases below. They use the
# installer from the working tree and a stub binary with --from-file, so they
# need no signed release:
#
#   MIGRATION_ONLY=1 sh deploy/test-install-docker.sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST=${1:-"$ROOT/dist"}
DOCKER=${DOCKER:-docker}
MIGRATION_ONLY=${MIGRATION_ONLY:-0}

# Git Bash converts /release into a Windows path for docker.exe unless told
# otherwise, and docker needs a Windows path for the volume. Handle both.
case "$(uname -s)" in
MSYS* | MINGW* | CYGWIN*)
	MSYS2_ARG_CONV_EXCL='*'
	export MSYS2_ARG_CONV_EXCL
	if command -v cygpath >/dev/null 2>&1; then
		DIST=$(cygpath -w "$DIST")
		ROOT=$(cygpath -w "$ROOT")
	fi
	;;
esac

if [ "$MIGRATION_ONLY" -eq 0 ] && [ ! -f "$DIST/SHA256SUMS.sig" ]; then
	echo "test-install-docker.sh: $DIST has no signed release; run deploy/release.sh first (or MIGRATION_ONLY=1)" >&2
	exit 1
fi

run_case() {
	image=$1
	prepare=$2
	public_host=$3
	expect_fallback=${4:-0}
	echo "== $image =="
	"$DOCKER" run --rm -v "$DIST:/release:ro" "$image" sh -c "
		set -e
		$prepare >/dev/null 2>&1
		sh /release/install.sh --base-url file:///release --no-systemd --preverified-signature \
			--data /var/lib/rostalk --user rostalk --public-host $public_host >/tmp/first 2>&1
		grep -q 'release signature OK' /tmp/first
		grep -q 'checksum verified' /tmp/first
		test -x /usr/local/bin/rostalk-server
		test -f /etc/systemd/system/rostalk-server.service
		id rostalk >/dev/null
		/usr/local/bin/rostalk-server version | grep -q 'rostalk-server'
		sh /release/install.sh --base-url file:///release --no-systemd --preverified-signature \
			--data /var/lib/rostalk --user rostalk --public-host $public_host >/tmp/second 2>&1
		echo '  ok: install, verify, unit, second run'
	"
	if [ "$expect_fallback" -eq 1 ]; then
		"$DOCKER" run --rm -v "$DIST:/release:ro" "$image" sh -c "
			set -e
			$prepare >/dev/null 2>&1
			sh /release/install.sh --base-url file:///release --no-systemd --preverified-signature \
				--data /var/lib/rostalk --user rostalk --public-host $public_host >/tmp/fallback 2>&1
			grep -q 'verified by the client' /tmp/fallback
			grep -q 'checksum verified' /tmp/fallback
			echo '  ok: OpenSSL 1.1.1 signature fallback used and warned'
		"
	fi
}

# Package names differ: Debian needs the passwd package for useradd, Fedora
# ships shadow-utils. openssl verifies the Ed25519 signature. The RHEL family
# gets the same minimal set; AlmaLinux 8 has OpenSSL 1.1.1, so the client-side
# signature fallback is checked there.
if [ "$MIGRATION_ONLY" -eq 0 ]; then
	run_case ubuntu:24.04 'apt-get update -qq && apt-get install -y -qq curl openssl ca-certificates' 192.0.2.21
	run_case debian:12-slim 'apt-get update -qq && apt-get install -y -qq curl openssl ca-certificates passwd' 192.0.2.22
	run_case fedora:41 'dnf install -y -q curl openssl ca-certificates shadow-utils' 192.0.2.23
	run_case almalinux:8 'dnf install -y -q curl openssl ca-certificates shadow-utils tar iproute' 192.0.2.24 1
	run_case rockylinux:9 'dnf install -y -q openssl ca-certificates shadow-utils tar iproute' 192.0.2.25
fi

# ------------------------------------------------- migration from Hearth ---
# These cases use install.sh from the working tree and a stub binary with
# --from-file, so they need neither a signed release nor network downloads.
MIGRATION_IMAGE=ubuntu:24.04

migration_run() { # shell commands, run inside a fresh container
	"$DOCKER" run --rm -v "$ROOT:/src:ro" "$MIGRATION_IMAGE" sh -c "set -e
$1"
}

# A minimal Hearth installation whose unit carries everything an upgraded
# server must keep: domain mode, a non-default control port and an explicit
# media address. The 0600 identity key stands in for the real TLS/id keys.
hearth_fixture='
	useradd --system --user-group hearth
	mkdir -p /var/lib/hearth/files /var/lib/hearth/logs
	echo db >/var/lib/hearth/hearth.db
	echo id >/var/lib/hearth/identity.key
	chmod 0600 /var/lib/hearth/identity.key
	echo a >/var/lib/hearth/files/a
	echo log >/var/lib/hearth/logs/hearth-server.log
	chown -R hearth:hearth /var/lib/hearth
	cat >/etc/systemd/system/hearth-server.service <<UNIT
[Unit]
Description=Hearth voice server

[Service]
ExecStart=/usr/local/bin/hearth-server run --data=/var/lib/hearth --listen=:9443 --public-host=voice.example.com --advertise-ip=192.0.2.40 --domain=voice.example.com --log-file=/var/lib/hearth/logs/hearth-server.log
UNIT
	printf "#!/bin/sh\n" >/usr/local/bin/hearth-server
	chmod 0755 /usr/local/bin/hearth-server
	printf "#!/bin/sh\nexit 0\n" >/tmp/fake-server
	chmod 0755 /tmp/fake-server
'

echo "== $MIGRATION_IMAGE, migration keeps domain, port and media address =="
migration_run "$hearth_fixture
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/migrate 2>&1
	grep -q 'installed as Hearth' /tmp/migrate
	grep -q 'keeping the Hearth service settings' /tmp/migrate
	unit=/etc/systemd/system/rostalk-server.service
	grep -q '^ExecStart=/usr/local/bin/rostalk-server run ' \$unit
	grep -q -- '--listen=:9443' \$unit
	grep -q -- '--domain=voice.example.com' \$unit
	grep -q -- '--public-host=voice.example.com' \$unit
	grep -q -- '--advertise-ip=192.0.2.40' \$unit
	grep -q -- '--log-file=/var/lib/rostalk/logs/hearth-server.log' \$unit
	test ! -e /var/lib/hearth
	test ! -e /var/lib/rostalk.migration
	test \"\$(cat /var/lib/rostalk/hearth.db)\" = db
	test \"\$(stat -c %U /var/lib/rostalk/identity.key)\" = rostalk
	test \"\$(stat -c %a /var/lib/rostalk/identity.key)\" = 600
	runuser -u rostalk -- test -r /var/lib/rostalk/identity.key
	test \"\$(stat -c %U /var/lib/rostalk/files/a)\" = rostalk
	test ! -e /etc/systemd/system/hearth-server.service
	test -f /etc/systemd/system/hearth-server.service.hearth-old
	test -f /usr/local/bin/hearth-server.hearth-old
	echo '  ok: data moved, settings kept, 0600 key readable by rostalk, old unit parked'
"

echo "== $MIGRATION_IMAGE, repeated install keeps the migrated settings =="
migration_run "$hearth_fixture
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/first 2>&1
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/second 2>&1
	grep -q 'keeping the current service settings' /tmp/second
	unit=/etc/systemd/system/rostalk-server.service
	grep -q -- '--domain=voice.example.com' \$unit
	grep -q -- '--listen=:9443' \$unit
	grep -q -- '--advertise-ip=192.0.2.40' \$unit
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd --listen=:9444 >/tmp/third 2>&1
	grep -q -- '--listen=:9444' \$unit
	grep -q -- '--domain=voice.example.com' \$unit
	grep -q -- '--advertise-ip=192.0.2.40' \$unit
	if grep -q -- '--listen=:9443' \$unit; then echo 'the old port won over the explicit one' >&2; exit 1; fi
	echo '  ok: second install kept domain, port and media address; explicit port won'
"

echo "== $MIGRATION_IMAGE, rollback restores a non-default legacy owner =="
fixturelegacy_fixture='
	useradd --system --user-group fixturelegacy
	mkdir -p /var/lib/hearth/files
	echo db >/var/lib/hearth/hearth.db
	echo id >/var/lib/hearth/identity.key
	chmod 0600 /var/lib/hearth/identity.key
	echo a >/var/lib/hearth/files/a
	chown -R fixturelegacy:fixturelegacy /var/lib/hearth
	cat >/etc/systemd/system/hearth-server.service <<UNIT
[Unit]
Description=Hearth voice server

[Service]
User=fixturelegacy
Group=fixturelegacy
ExecStart=/usr/local/bin/hearth-server run --data=/var/lib/hearth --listen=:9443 --public-host=voice.example.com --advertise-ip=192.0.2.40 --domain=voice.example.com
UNIT
	printf "#!/bin/sh\n" >/usr/local/bin/hearth-server
	chmod 0755 /usr/local/bin/hearth-server
	printf "#!/bin/sh\nexit 0\n" >/tmp/fake-server
	chmod 0755 /tmp/fake-server
'
migration_run "$fixturelegacy_fixture
	if sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd \\
		--log-file=/proc/rostalk-test/server.log >/tmp/legacyfail 2>&1; then
		echo 'install.sh did not fail on an impossible log directory' >&2
		exit 1
	fi
	grep -q 'migration from Hearth did not finish' /tmp/legacyfail
	test -d /var/lib/hearth
	test ! -e /var/lib/rostalk
	test ! -e /var/lib/rostalk.migration
	test \"\$(stat -c %U /var/lib/hearth/identity.key)\" = fixturelegacy
	test \"\$(stat -c %G /var/lib/hearth/identity.key)\" = fixturelegacy
	test \"\$(stat -c %a /var/lib/hearth/identity.key)\" = 600
	test \"\$(stat -c %U /var/lib/hearth/files/a)\" = fixturelegacy
	runuser -u fixturelegacy -- test -r /var/lib/hearth/identity.key
	test -f /etc/systemd/system/hearth-server.service
	test ! -e /etc/systemd/system/hearth-server.service.hearth-old
	if id -u hearth >/dev/null 2>&1; then echo 'the fixture must not have a hearth user' >&2; exit 1; fi
	echo '  ok: fixturelegacy owns its 0600 key and group again, mode kept'
"

echo "== $MIGRATION_IMAGE, failed ownership restore is reported and retryable =="
migration_run "$hearth_fixture
	# A unit naming a user that does not exist makes the rollback chown fail.
	sed -i '/^\[Service\]/a User=ghostlegacy\nGroup=ghostlegacy' /etc/systemd/system/hearth-server.service
	if sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd \\
		--log-file=/proc/rostalk-test/server.log >/tmp/ghostfail 2>&1; then
		echo 'install.sh did not fail on an impossible log directory' >&2
		exit 1
	fi
	grep -q 'could not restore owner ghostlegacy:ghostlegacy' /tmp/ghostfail
	grep -q 'the automatic restore did not finish' /tmp/ghostfail
	test -d /var/lib/hearth
	test ! -e /var/lib/rostalk
	test -e /var/lib/rostalk.migration
	test \"\$(stat -c %a /var/lib/hearth/identity.key)\" = 600
	test -f /etc/systemd/system/hearth-server.service
	if id -u ghostlegacy >/dev/null 2>&1; then echo 'the fixture must not create ghostlegacy' >&2; exit 1; fi

	# The retained data and marker let the next run finish the migration.
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/ghostretry 2>&1
	test -f /var/lib/rostalk/identity.key
	test \"\$(stat -c %U /var/lib/rostalk/identity.key)\" = rostalk
	test \"\$(stat -c %a /var/lib/rostalk/identity.key)\" = 600
	test ! -e /var/lib/rostalk.migration
	echo '  ok: the real chown error is reported, data kept, retry completed'
"

echo "== $MIGRATION_IMAGE, explicit update settings override the old unit =="
migration_run "$hearth_fixture
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd \\
		--listen=:9444 --advertise-ip=198.51.100.7 >/tmp/migrate 2>&1
	unit=/etc/systemd/system/rostalk-server.service
	grep -q -- '--listen=:9444' \$unit
	grep -q -- '--advertise-ip=198.51.100.7' \$unit
	grep -q -- '--domain=voice.example.com' \$unit
	if grep -q -- '--listen=:9443' \$unit; then echo 'old port won over the explicit one' >&2; exit 1; fi
	if grep -q -- '--advertise-ip=192.0.2.40' \$unit; then echo 'old media address won over the explicit one' >&2; exit 1; fi
	echo '  ok: explicit --listen and --advertise-ip win, domain is inherited'
"

echo "== $MIGRATION_IMAGE, unknown old unit settings stop before any change =="
migration_run "$hearth_fixture
	sed -i 's|--domain=voice.example.com|--tls-cert=/etc/hearth/cert.pem|' /etc/systemd/system/hearth-server.service
	if sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/unsupported 2>&1; then
		echo 'install.sh accepted an unknown Hearth setting' >&2
		exit 1
	fi
	grep -q 'cannot carry the service settings over automatically' /tmp/unsupported
	grep -q 'data has not been moved' /tmp/unsupported
	test -d /var/lib/hearth
	test -f /var/lib/hearth/identity.key
	test ! -e /var/lib/rostalk
	test -f /etc/systemd/system/hearth-server.service
	test ! -e /etc/systemd/system/hearth-server.service.hearth-old
	test ! -e /var/lib/rostalk.migration
	echo '  ok: old service and data untouched, administrator got instructions'
"

echo "== $MIGRATION_IMAGE, failed useradd restores Hearth, retry finishes =="
migration_run "$hearth_fixture
	mkdir -p /tmp/fakebin
	printf '#!/bin/sh\nexit 1\n' >/tmp/fakebin/useradd
	chmod 0755 /tmp/fakebin/useradd
	if PATH=/tmp/fakebin:\$PATH sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/fail 2>&1; then
		echo 'install.sh did not fail with the broken useradd' >&2
		exit 1
	fi
	grep -q 'migration from Hearth did not finish' /tmp/fail
	test -d /var/lib/hearth
	test -f /var/lib/hearth/identity.key
	test ! -e /var/lib/rostalk
	test ! -e /var/lib/rostalk.migration
	test -f /etc/systemd/system/hearth-server.service
	test ! -e /etc/systemd/system/hearth-server.service.hearth-old
	test -f /usr/local/bin/hearth-server
	runuser -u hearth -- test -r /var/lib/hearth/identity.key

	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/retry 2>&1
	grep -q 'installed as Hearth' /tmp/retry
	test ! -e /var/lib/hearth
	test -f /var/lib/rostalk/identity.key
	test \"\$(stat -c %U /var/lib/rostalk/identity.key)\" = rostalk
	test \"\$(stat -c %a /var/lib/rostalk/identity.key)\" = 600
	runuser -u rostalk -- test -r /var/lib/rostalk/identity.key
	test ! -e /var/lib/rostalk.migration
	echo '  ok: failure restored Hearth, repeated install completed the migration'
"

echo "== $MIGRATION_IMAGE, interrupted move is finished by the next run =="
migration_run "$hearth_fixture
	# What a hard kill leaves behind: data already moved by the old owner, the
	# marker present, the old unit and binary not parked yet, no new user.
	mv /var/lib/hearth /var/lib/rostalk
	: >/var/lib/rostalk.migration
	sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd >/tmp/resume 2>&1
	grep -q 'completing an interrupted migration from Hearth' /tmp/resume
	unit=/etc/systemd/system/rostalk-server.service
	grep -q -- '--listen=:9443' \$unit
	grep -q -- '--advertise-ip=192.0.2.40' \$unit
	grep -q -- '--domain=voice.example.com' \$unit
	test ! -e /var/lib/hearth
	test ! -e /var/lib/rostalk.migration
	test \"\$(stat -c %U /var/lib/rostalk/identity.key)\" = rostalk
	test \"\$(stat -c %a /var/lib/rostalk/identity.key)\" = 600
	runuser -u rostalk -- test -r /var/lib/rostalk/identity.key
	test ! -e /etc/systemd/system/hearth-server.service
	test -f /etc/systemd/system/hearth-server.service.hearth-old
	echo '  ok: half-migrated directory was handed over and the 0600 key became readable'
"

echo "== $MIGRATION_IMAGE, failure after the handover rolls ownership back =="
migration_run "$hearth_fixture
	# A log directory under /proc cannot be created, so install.sh fails after
	# it has already changed the owner of the data directory.
	if sh /src/deploy/install.sh --from-file /tmp/fake-server --no-systemd \\
		--log-file=/proc/rostalk-test/server.log >/tmp/latefail 2>&1; then
		echo 'install.sh did not fail on an impossible log directory' >&2
		exit 1
	fi
	grep -q 'migration from Hearth did not finish' /tmp/latefail
	test -d /var/lib/hearth
	test ! -e /var/lib/rostalk
	test ! -e /var/lib/rostalk.migration
	test \"\$(stat -c %U /var/lib/hearth/identity.key)\" = hearth
	test \"\$(stat -c %a /var/lib/hearth/identity.key)\" = 600
	runuser -u hearth -- test -r /var/lib/hearth/identity.key
	test -f /etc/systemd/system/hearth-server.service
	test ! -e /etc/systemd/system/hearth-server.service.hearth-old
	echo '  ok: data and owners are back with Hearth, 0600 key still readable'
"

echo "all install.sh container checks passed"
