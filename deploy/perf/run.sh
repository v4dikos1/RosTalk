#!/bin/sh
# Local Linux measurement stand: bad network (tc netem) and the ICE-TCP
# fallback (iptables drops UDP 7882). Never point this at the production VPS and
# never apply tc on the host: everything happens inside the client container.
#
#   sh deploy/perf/run.sh baseline
#   sh deploy/perf/run.sh loss5  USERS=10 DURATION=120s
#   sh deploy/perf/run.sh jitter USERS=6
#   sh deploy/perf/run.sh tcp
#
# Environment:
#   USERS, CHANNELS, TALKING, DURATION, CHANNEL_NAMES (comma-separated),
#   ADMIN_LINK (optional one-time admin link used to create load-<i> channels)
set -eu

# Git Bash rewrites POSIX-looking arguments such as --data=/data into Windows
# paths before docker sees them. The containers must get the paths verbatim.
MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL

SCENARIO=${1:-baseline}
COMPOSE="docker compose -f deploy/perf/compose.yaml"
USERS=${USERS:-10}
CHANNELS=${CHANNELS:-1}
TALKING=${TALKING:-$USERS}
DURATION=${DURATION:-60s}
STRICT=${STRICT:-1}

info() { echo "==> $*"; }

cleanup() {
	$COMPOSE exec -T client sh -c 'tc qdisc del dev eth0 root 2>/dev/null || true; iptables -F OUTPUT 2>/dev/null || true' >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

info "starting the stand"
$COMPOSE up -d --build

info "waiting for the server"
i=0
while ! $COMPOSE exec -T server rostalk-server healthcheck --data=/data --url=https://172.28.10.10:7443/healthz >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -gt 60 ]; then
		echo "server did not become healthy" >&2
		$COMPOSE logs server >&2
		exit 1
	fi
	sleep 1
done

if [ "$CHANNELS" -gt 1 ] && [ -z "${CHANNEL_NAMES:-}" ] && [ -n "${ADMIN_LINK:-}" ]; then
	info "creating $CHANNELS load channels with the admin link"
	i=1
	while [ "$i" -le "$CHANNELS" ]; do
		$COMPOSE exec -T client rostalkctl channels create "$ADMIN_LINK" "load-$i" \
			--identity /work/admin.key --nick perf-admin >/dev/null
		i=$((i + 1))
	done
fi

info "creating an invite"
LINK=$($COMPOSE exec -T server rostalk-server invite --data=/data \
	--public-host=172.28.10.10:7443 --max-uses 1000 | tail -n 1)
case "$LINK" in
rostalk://join?*) ;;
*)
	echo "could not read the invite link: $LINK" >&2
	exit 1
	;;
esac

NETEM=
TCP_CHECK=0
case "$SCENARIO" in
baseline) ;;
loss5) NETEM="loss 5%" ;;
loss10) NETEM="loss 10%" ;;
jitter) NETEM="delay 20ms 50ms distribution normal" ;;
loss5-jitter) NETEM="loss 5% delay 20ms 50ms distribution normal" ;;
tcp)
	# The server advertises an ICE-TCP passive candidate on 7881. This scenario
	# only proves that the fallback port is listening and reachable from the
	# client network; the Go load generator cannot exercise active ICE-TCP
	# (Pion SDK), so the end-to-end fallback is checked with the Windows voice
	# integration test (docs/PERF.md).
	TCP_CHECK=1
	;;
*)
	echo "unknown scenario $SCENARIO (baseline, loss5, loss10, jitter, loss5-jitter, tcp)" >&2
	exit 2
	;;
esac

if [ "$TCP_CHECK" -eq 1 ]; then
	info "checking the ICE-TCP fallback port 7881"
	$COMPOSE exec -T client sh -c 'nc -z -w 5 172.28.10.10 7881'
	$COMPOSE exec -T server sh -c 'netstat -lnt 2>/dev/null | grep -q ":7881 " || ss -lnt | grep -q ":7881 "'
	info "TCP 7881 is listening and reachable; the server offers tcptype passive (see the load log)"
	$COMPOSE exec -T client sh -c "nc -z -w 5 172.28.10.10 7881 && echo tcp-ok"
	exit 0
fi

if [ -n "$NETEM" ]; then
	info "applying tc netem: $NETEM"
	$COMPOSE exec -T client sh -c "tc qdisc replace dev eth0 root netem $NETEM"
fi

CHANNEL_FLAGS=
if [ -n "${CHANNEL_NAMES:-}" ]; then
	CHANNEL_FLAGS="--channel $CHANNEL_NAMES"
fi

info "load: users=$USERS channels=$CHANNELS talking=$TALKING duration=$DURATION scenario=$SCENARIO"
METRICS_FILE=/tmp/rostalk-metrics.$$
rm -f "$METRICS_FILE"
(
	while :; do
		$COMPOSE exec -T server wget -qO- http://127.0.0.1:9090/metrics >"$METRICS_FILE.tmp" 2>/dev/null &&
			mv "$METRICS_FILE.tmp" "$METRICS_FILE"
		sleep 5
	done
) &
SAMPLER=$!
set +e
# shellcheck disable=SC2086
$COMPOSE exec -T client rostalkctl load "$LINK" \
	--users "$USERS" --channels "$CHANNELS" --talking "$TALKING" \
	--duration "$DURATION" --json $CHANNEL_FLAGS \
	--strict="$STRICT" >/tmp/rostalk-load.out 2>/tmp/rostalk-load.err
LOAD_STATUS=$?
set -e
kill "$SAMPLER" 2>/dev/null || true
wait "$SAMPLER" 2>/dev/null || true
cat /tmp/rostalk-load.out
if [ -s /tmp/rostalk-load.err ]; then
	cat /tmp/rostalk-load.err >&2
fi
if [ -s "$METRICS_FILE" ]; then
	info "last metrics sample during the run"
	grep -E '^(rostalk_|process_resident_memory_bytes)' "$METRICS_FILE" || true
fi

TESTS_FAILED=0
if [ "$LOAD_STATUS" -ne 0 ]; then
	TESTS_FAILED=1
fi

info "server counters"
$COMPOSE exec -T server wget -qO- http://127.0.0.1:9090/metrics |
	grep -E '^(rostalk_|process_resident_memory_bytes|go_goroutines)' || true
info "container usage"
docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' |
	grep -E 'rostalk-perf' || true

if [ "$TESTS_FAILED" -ne 0 ]; then
	echo "scenario $SCENARIO failed" >&2
	exit 1
fi
info "scenario $SCENARIO passed"
