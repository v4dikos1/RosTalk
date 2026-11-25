#!/bin/sh
# Full "install the server from the client over SSH" test.
#
#   sh deploy/test-client-install-docker.sh
#
# Builds a small ubuntu:24.04 image with sshd, sudo, a fake systemctl and a
# throwaway sshd on 127.0.0.1:2222, then runs the ignored Rust integration test
# from client/src-tauri/crates/hosting/tests/install_ssh.rs. The real signed
# server bundle is uploaded and installed; the service answers /healthz through
# the fake unit and the admin link is used to connect a RosTalk core client.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOCKER=${DOCKER:-docker}
CARGO=${CARGO:-cargo}
IMAGE=${IMAGE:-rostalk-client-install-test}
NAME=${NAME:-rostalk-client-install-test}
BUNDLE=${ROSTALK_SERVER_BUNDLE:-"$ROOT/client/src-tauri/resources/server"}
HOST_SSH_PORT=${HOST_SSH_PORT:-2222}
HOST_HTTPS_PORT=${HOST_HTTPS_PORT:-17443}

if [ ! -f "$BUNDLE/SHA256SUMS.sig" ]; then
	echo "test-client-install-docker.sh: $BUNDLE has no signed bundle; run make server-bundle first" >&2
	exit 1
fi

case "$(uname -s)" in
MSYS* | MINGW* | CYGWIN*)
	MSYS2_ARG_CONV_EXCL='*'
	export MSYS2_ARG_CONV_EXCL
	;;
esac

to_docker_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -w "$1"
	else
		printf '%s' "$1"
	fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/rostalk-client-install.XXXXXX")
cleanup() {
	"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "==> building the sshd container"
"$DOCKER" build -q -t "$IMAGE" -f "$(to_docker_path "$ROOT/deploy/test-client-install/Dockerfile")" "$(to_docker_path "$ROOT/deploy/test-client-install")" >/dev/null

"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
echo "==> starting sshd on 127.0.0.1:${HOST_SSH_PORT} (HTTPS ${HOST_HTTPS_PORT})"
"$DOCKER" run -d --name "$NAME" \
	-p "127.0.0.1:${HOST_SSH_PORT}:22" \
	-p "127.0.0.1:${HOST_HTTPS_PORT}:7443" \
	"$IMAGE" >/dev/null

# A throwaway key for the key-auth negative/positive path. The public half is
# copied into the container; the private half never leaves the temp directory.
if command -v ssh-keygen >/dev/null 2>&1; then
	ssh-keygen -q -t ed25519 -N "" -C "rostalk-client-install-test" -f "$TMP/id_ed25519"
	"$DOCKER" cp "$(to_docker_path "$TMP/id_ed25519.pub")" "$NAME:/root/.ssh/authorized_keys" >/dev/null
	KEY_PATH=$(to_docker_path "$TMP/id_ed25519")
else
	echo "test-client-install-docker.sh: ssh-keygen is missing; key-auth test will be skipped" >&2
	KEY_PATH=
fi

echo "==> waiting for sshd"
i=0
while [ $i -lt 60 ]; do
	if "$DOCKER" exec "$NAME" sh -c 'ss -ltn | grep -q ":22 "' >/dev/null 2>&1; then
		break
	fi
	i=$((i + 1))
	sleep 1
done
if [ $i -ge 60 ]; then
	echo "test-client-install-docker.sh: sshd did not start" >&2
	"$DOCKER" logs "$NAME" | tail -n 80 >&2 || true
	exit 1
fi

echo "==> running the ignored Rust integration test"
status=0
(
	cd "$ROOT/client/src-tauri"
	ROSTALK_SERVER_BUNDLE="$(to_docker_path "$BUNDLE")" \
	ROSTALK_TEST_SSH_ADDR="127.0.0.1:${HOST_SSH_PORT}" \
	ROSTALK_TEST_HTTPS_PORT="${HOST_HTTPS_PORT}" \
	ROSTALK_TEST_SSH_USER="${ROSTALK_TEST_SSH_USER:-rostalktest}" \
	ROSTALK_TEST_SSH_PASSWORD="${ROSTALK_TEST_SSH_PASSWORD:-rostalkpass}" \
	ROSTALK_TEST_SSH_ROOT_USER="${ROSTALK_TEST_SSH_ROOT_USER:-root}" \
	ROSTALK_TEST_SSH_ROOT_PASSWORD="${ROSTALK_TEST_SSH_ROOT_PASSWORD:-rootpass}" \
	ROSTALK_TEST_SSH_KEY="${KEY_PATH}" \
	"$CARGO" test -p rostalk-hosting --test install_ssh -- --ignored --nocapture --test-threads=1
) || status=$?

if [ $status -ne 0 ]; then
	echo "==> integration test failed; container logs:"
	"$DOCKER" exec "$NAME" sh -c 'tail -n 100 /var/log/rostalk.log 2>/dev/null || true' >&2 || true
	"$DOCKER" logs --tail 80 "$NAME" >&2 || true
fi

exit $status
