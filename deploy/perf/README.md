# Local performance stand (stage 7.1)

A throwaway Linux network for the measurements in `docs/PERF.md`:

- `server` — the real `rostalk-server` image on `172.28.10.10`;
- `client` — `rostalkctl` plus `iproute2`/`iptables` on `172.28.10.20`.

Nothing is published to the host and nothing runs with `--network host`, so the
stand works on Docker Desktop for Windows (ADR 0001).

```sh
docker compose -f deploy/perf/compose.yaml up -d --build
sh deploy/perf/run.sh baseline      # USERS=10 DURATION=60s by default
sh deploy/perf/run.sh loss5
sh deploy/perf/run.sh loss10
sh deploy/perf/run.sh jitter
sh deploy/perf/run.sh tcp           # 7881 reachability
docker compose -f deploy/perf/compose.yaml down -v
```

`run.sh` applies `tc netem` (5 %/10 % loss, 50 ms jitter) to the client
container's `eth0`, and drops outbound UDP 7882 for nothing by default: the TCP
scenario only checks that 7881 is listening and reachable. The Go load
generator cannot exercise active ICE-TCP (the Pion SDK does not gather active
TCP candidates), so the end-to-end fallback belongs to the Windows client test.

`DURATION` defaults to 60 s. The script prints the load summary, the last
Prometheus sample taken during the run and `docker stats` for both containers.
`STRICT=0` tolerates a connect failure; the default fails the scenario.

For more than one channel, either pass existing names
(`CHANNEL_NAMES="Lobby,Games" CHANNELS=2`) or create them first with
`rostalkctl channels create` using a one-time administrator link (`ADMIN_LINK`);
the default server has only Lobby and AFK.

The numbers in `docs/PERF.md` were taken on the real Linux VPS, not here; this
network is for the bad-network scenarios and for reproducing the TCP/media
checks without touching production.
