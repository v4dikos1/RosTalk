# Contributing to RosTalk

Thanks for helping. RosTalk is a self-hosted voice chat: a Go server with an
embedded LiveKit SFU and a Windows client on Tauri 2 (Rust core + React UI).
The rules below are the same ones the maintainers follow; a pull request that
breaks them will be asked to change, even if it works.

Design documents are in Russian; code, comments and commit messages are in
English. Issues and pull requests in either language are welcome.

## Before you start

- Read [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md) and the
  decisions in [`docs/adr/`](docs/adr/). ADRs are newer than the design and
  win when they disagree.
- For anything bigger than a bug fix, open an issue first so we can agree on
  the approach.
- A change that departs from the design comes with a new
  `docs/adr/NNNN-title.md`: context, decision, consequences.
- The Windows client is the product. Browser and mobile clients are secondary
  and must not make the desktop worse.

## Development setup

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for toolchains, the dev
server in Docker, building the client and running the tests.

## The contract

- `proto/rostalk/v1` is the source of truth for the control protocol. When
  you change a `.proto`, run `make gen` and update the server, the Rust core
  and the UI in the same pull request.
- Incompatible wire changes need a protocol version bump. `make check` runs
  `buf breaking` against `main`.

## General rules

- Every permission check happens on the server. The client only hides what
  the user cannot do.
- Never log tokens, keys, passwords or message contents.
- Do not guess third-party APIs: check the documentation of the pinned
  version (docs.rs, pkg.go.dev).
- New dependencies must be stable releases; explain why in the pull request.

## Environment

- The server runs on Linux only. On Windows run it in Docker Desktop
  (`make dev-server-docker`); do not build it natively for Windows.
- The client connects to that server at `https://<LAN IP of the host>:7443`.
  `localhost` does not work for media from a Windows host: the client's ICE
  socket is bound to the LAN address (ADR 0001). Ports 7443/tcp, 7881/tcp and
  7882/udp are published; do not use `--network host` in Docker Desktop.
- Server integration tests on Windows run in a container:
  `make test-server-docker`.
- The Windows client builds only with the MSVC toolchain (Visual Studio Build
  Tools + WebView2).

## Go (`server/`, `tools/`)

- `CGO_ENABLED=0`, logging through `log/slog`, errors wrapped with context.
- `server/` and `tools/rostalkctl` are separate Go modules: `livekit-server`
  and `server-sdk-go` pull incompatible forks of Pion (ADR 0001).
  `server-sdk-go` is allowed only under `tools/`.
- TLS without a domain uses a separate CA and a leaf signed by it; the `fp`
  in an invite link is the leaf fingerprint. Never use the CA certificate as
  the server leaf: Go accepts it, rustls does not.
- When embedding LiveKit, call `prometheus.Init` before
  `service.InitializeServer`.
- LiveKit is referenced only inside `server/internal/media`.
- Tests: `go test ./... -race`. Integration tests start a real server on a
  random port in a temporary directory.

## Rust (`client/src-tauri`)

- No `unwrap` outside tests. `cargo clippy -- -D warnings`, `cargo fmt`.
- Audio callbacks: no locks, no allocations, no logging; exchange data
  through ring buffers.
- The audio processing module takes 10 ms frames only; resample to 48 kHz
  before it; echo cancellation needs the reverse stream. Opus FEC cannot be
  configured through the SDK (ADR 0002).
- `cpal` is pinned to 0.18: `Device::description()?.name()`, `StreamConfig`
  by value, `SampleRate = u32`.
- Application state lives in the core. The UI receives snapshots and deltas.

## UI (`client/ui`)

- TypeScript strict, shadcn/ui components, Tailwind styles, every string
  through i18n (Russian and English).
- Animations use only `transform` and `opacity` and last at most 150 ms.
- The UI never talks to the network directly: only through the core's IPC and
  the local proxy.

## Anti-cheat safety (Windows client)

People run RosTalk next to games protected by kernel-level anti-cheats
(Vanguard, Easy Anti-Cheat, BattlEye, FACEIT). The client must look and behave
like an ordinary user-mode application:

- it never touches other processes, other windows or other programs' input;
- no drivers, no injection, no hooks, no synthetic input, no hiding or
  obfuscation.

The full allow/deny list and how it is enforced are in
[`docs/anticheat.md`](docs/anticheat.md). Anything not on the allow list needs
an ADR and a live run with the anti-cheat first. `make check-anticheat` (part
of `make check`) must pass; do not add exceptions to
`tools/anticheat/allowlist.txt` yourself — raise the question in the pull
request instead.

## Before you open a pull request

- `make check` passes in full.
- If you touched the client: the release build `make build-client` starts,
  and `make check-anticheat-imports` passes on Windows.
- If you touched voice, streams or input: describe the live test you did.
- Keep one topic per pull request; write the commit message in English.

There is no hosted CI yet: maintainers run the same checks locally before
merging (ADR 0015).

## Reporting security issues

Please do not open public issues for vulnerabilities. See
[`SECURITY.md`](SECURITY.md).
