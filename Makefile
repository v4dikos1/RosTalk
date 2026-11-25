# RosTalk monorepo.
#
# Recipes are plain commands so they run both in sh (Linux/macOS, CI) and in
# cmd.exe (Windows, GNU make for Windows): no WSL and no bash required.
#
#   make gen     regenerate Go/Rust/TypeScript code from proto/rostalk/v1
#   make check   everything CI runs: contract, both Go modules, Rust, UI
#
# The server runs only on Linux. On Windows it is built and tested in Docker
# Desktop through the *-docker targets (design 7, ADR 0001).

GO ?= go
BUF ?= buf
CARGO ?= cargo
NPM ?= npm
NODE ?= node
GOLANGCI_LINT ?= golangci-lint
DOCKER_COMPOSE ?= docker compose
ifeq ($(OS),Windows_NT)
# POSIX shell for release/bundle scripts (Git for Windows).
SH ?= C:/Program Files/Git/bin/sh.exe
else
SH ?= sh
endif

# Stage 6.2: updater signing key. The private key lives outside the repository
# (by default under %USERPROFILE%); the public key is in tauri.conf.json.
# Override with TAURI_SIGNING_PRIVATE_KEY=/path/to/key.
# Keys made before the RosTalk rename (ADR 0033) are still found under .hearth.
UPDATER_KEY ?= $(if $(wildcard $(USERPROFILE)/.rostalk/release/rostalk-updater.key),$(USERPROFILE)/.rostalk/release/rostalk-updater.key,$(if $(wildcard $(USERPROFILE)/.hearth/release/hearth-updater.key),$(USERPROFILE)/.hearth/release/hearth-updater.key,$(USERPROFILE)/.rostalk/release/rostalk-updater.key))

# P13 (ADR 0026): GitHub repository of the releases, owner/name. It is baked
# into the client (default update source, "own server" page), into install.sh
# and latest.json, and used by publish-release. VERSION is the release version
# (x.y.z) for `make release` and `make publish-release`.
RELEASE_REPO ?= v4dikos1/RosTalk
VERSION ?=

# The anti-cheat scripts are POSIX sh: Git Bash on Windows, sh on Linux. Git
# for Windows ships sh.exe but keeps it off PATH, so name it explicitly there
# (override with `make check-anticheat ANTICHEAT_SH=sh` inside Git Bash).
ifeq ($(OS),Windows_NT)
ANTICHEAT_SH ?= C:/Program Files/Git/bin/sh.exe
ANTICHEAT_PS ?= powershell -NoProfile -ExecutionPolicy Bypass
# The speech fixture uses Windows SAPI (stage 2.3.2e).
SPEECH_FIXTURE_PS ?= powershell -NoProfile -ExecutionPolicy Bypass
else
ANTICHEAT_SH ?= sh
ANTICHEAT_PS ?= pwsh -NoProfile
SPEECH_FIXTURE_PS ?= pwsh -NoProfile
endif

PROTO_DIR := proto
GEN_GO_DIR := proto/gen/go
SERVER_DIR := server
HCTL_DIR := tools/rostalkctl
TAURI_DIR := client/src-tauri
UI_DIR := client/ui
COMPOSE_FILE := deploy/dev/compose.yaml

# Git ref the contract is compared against by `make proto-breaking`.
BUF_BASE ?= origin/main

# A breaking check needs a baseline. The first PR that introduces proto/ has
# none on the base branch, so the target is skipped until the contract is merged
# (the CI job performs the same check).
# `git ls-tree` returns an empty string instead of a fatal error when the path
# does not exist, which keeps make output clean on the first PR.
BUF_BASELINE := $(shell git ls-tree --name-only $(BUF_BASE) proto/buf.yaml)
ifeq ($(BUF_BASELINE),)
PROTO_BREAKING :=
else
PROTO_BREAKING := proto-breaking
endif

# The Go race detector needs cgo. Windows dev hosts build with CGO_ENABLED=0 and
# have no C toolchain, so plain tests run there; Linux CI and
# `make test-server-docker` always run with -race (CONTRIBUTING.md).
ifeq ($(OS),Windows_NT)
GO_RACE :=
# The Tauri shell is built on Windows only (design 1), so the IPC binding check
# runs only there. The voice pipeline tests need MSVC/libwebrtc as well.
RUST_BINDINGS := rust-bindings-check
RUST_VOICE := test-voice
else
GO_RACE := -race
RUST_BINDINGS :=
RUST_VOICE :=
endif

# Protocol generation is fully local: `make tools` installs pinned protoc
# plugins as real executables into bin/protogen, buf finds them through PATH.
# No Buf Schema Registry round trip, so `make check` is deterministic and immune
# to BSR rate limits (the registry was only used by remote plugins before).
ifeq ($(OS),Windows_NT)
EXE := .exe
NULL := NUL
PROTO_BIN := $(subst /,\,$(CURDIR))\bin\protogen
export PATH := $(PROTO_BIN);$(PROTO_BIN)\bin;$(subst /,\,$(CURDIR))\client\ui\node_modules\.bin;$(PATH)
else
EXE :=
NULL := /dev/null
PROTO_BIN := $(CURDIR)/bin/protogen
export PATH := $(PROTO_BIN):$(PROTO_BIN)/bin:$(CURDIR)/client/ui/node_modules/.bin:$(PATH)
endif

# `go install` writes the plugin here, next to the cargo one, so a single cache
# directory and a single PATH entry cover the whole generation toolchain.
export GOBIN := $(PROTO_BIN)

PROTOC_GEN_GO_VERSION := v1.36.10
PROTOC_GEN_PROST_VERSION := 0.4.0
# protoc-gen-es is a dev dependency of client/ui, its version is pinned there.
PROTO_TOOLS_STAMP := bin/protogen/.versions

# Generated output lives only in these directories; any diff there means the
# committed bindings are stale.
GENERATED_DIRS := $(PROTO_DIR)/gen $(UI_DIR)/src/proto $(TAURI_DIR)/crates/core/src/proto

# `npm ci` is skipped while node_modules is in place. The hidden stamp file is
# created by npm itself, so a stale install is refreshed when the lockfile
# changes.
UI_DEPS_STAMP := $(UI_DIR)/node_modules/.package-lock.json

.DEFAULT_GOAL := help

.PHONY: help setup tools gen proto-lint proto-format proto-breaking verify-generated \
	go-lint go-fmt go-test rust-fmt rust-lint rust-test test-voice test-voice-quality audio-fixtures gen-ipc rust-bindings-check \
	ui-deps ui-typecheck ui-lint ui-test ui-build build-client release-client release-key build-server \
	release-server dev-server dev-client dev-server-docker test-server-docker check-media \
	test-install-docker check-anticheat check-anticheat-imports precommit install-hooks \
	server-bundle client-portable test-client-install-docker \
	build-server-setup dev-server-setup release publish-release \
	mutants mutants-rust mutants-go mutants-ui mutants-report

help:
	@echo RosTalk - common targets:
	@echo   make setup              install dependencies (npm ci, go mod download, protoc plugins)
	@echo   make tools              install the pinned protoc plugins only
	@echo   make gen                regenerate protocol bindings (Go, Rust, TypeScript)
	@echo   make check              all checks CI runs
	@echo   make check-anticheat    anti-cheat rules: sources and dependency graph
	@echo   make check-anticheat-imports  imports of the release exe (Windows, after make build-client)
	@echo   make test-voice         voice pipeline tests with file audio (Windows)
	@echo   make test-voice-quality measured audio quality: THD+N, gaps, NS, AEC, 60 s underruns (Windows)
	@echo   make dev-server         run the server from source (Linux only)
	@echo   make dev-client         run the desktop client with the Vite dev server
	@echo   make dev-server-docker  build the dev image and start the server container
	@echo   make test-server-docker run the server tests in the Linux test container
	@echo   make build-server       build the server binary into bin/
	@echo   make release-server     build signed linux/amd64+arm64 artefacts into dist/ (Linux or Docker)
	@echo   make server-bundle      build the signed server bundle for rostalk-server-setup
	@echo   make client-portable    assemble dist/rostalk-client-portable with rostalk.exe
	@echo   make test-client-install-docker  SSH installer test against an sshd container
	@echo   make test-install-docker  run install.sh in clean ubuntu, debian and fedora containers
	@echo   make build-client       build the UI and the Tauri shell
	@echo   make build-server-setup build the Windows server installer (rostalk-server-setup.exe)
	@echo   make release VERSION=x.y.z      build the whole release into dist/release-x.y.z
	@echo   make publish-release VERSION=x.y.z [DRY_RUN=1]  upload it to GitHub Releases (owner, gh)
	@echo   make release-client     build the NSIS installer and updater signature (Windows)
	@echo   make release-key        generate the updater signing keypair (Windows)
	@echo   make mutants            mutation testing, all areas (docs/TEST-QUALITY.md; slow)
	@echo   make mutants-rust       mutation testing of the client core (cargo-mutants)
	@echo   make mutants-go         mutation testing of the server packages (gremlins)
	@echo   make mutants-ui         mutation testing of the UI logic (StrykerJS)
	@echo   make mutants-report     print the mutation score from the last runs
	@echo   make install-hooks      use .githooks/ for git hooks
	@echo See README.md for the Windows quick start and the LAN IP requirement.

setup: ui-deps $(PROTO_TOOLS_STAMP)
	cd $(SERVER_DIR) && $(GO) mod download
	cd $(HCTL_DIR) && $(GO) mod download
	cd $(GEN_GO_DIR) && $(GO) mod download

# ---------------------------------------------------------------- contract ---

# Installs the pinned protoc plugins. `make gen` and `make check` do it
# automatically when the stamp is missing; the versions are bumped together with
# the generated code.
$(PROTO_TOOLS_STAMP):
	$(GO) install google.golang.org/protobuf/cmd/protoc-gen-go@$(PROTOC_GEN_GO_VERSION)
	$(CARGO) install protoc-gen-prost --version $(PROTOC_GEN_PROST_VERSION) --locked --root bin/protogen
	echo protoc-gen-go $(PROTOC_GEN_GO_VERSION) / protoc-gen-prost $(PROTOC_GEN_PROST_VERSION) > $(PROTO_TOOLS_STAMP)

tools: ui-deps $(PROTO_TOOLS_STAMP)
	@echo protoc plugins are installed: protoc-gen-go $(PROTOC_GEN_GO_VERSION), protoc-gen-prost $(PROTOC_GEN_PROST_VERSION), protoc-gen-es from client/ui

gen: ui-deps $(PROTO_TOOLS_STAMP)
	cd $(PROTO_DIR) && $(BUF) generate

proto-lint:
	cd $(PROTO_DIR) && $(BUF) lint

proto-format:
	cd $(PROTO_DIR) && $(BUF) format --diff --exit-code

proto-breaking:
	cd $(PROTO_DIR) && $(BUF) breaking --against "../.git#branch=$(BUF_BASE),subdir=proto"

# Fails when the committed bindings differ from what the .proto files produce.
# `git status --porcelain` also catches newly generated (untracked) files.
verify-generated: gen
	@$(if $(shell git status --porcelain -- $(GENERATED_DIRS)),$(error Generated code is out of date: run make gen and commit the result),echo generated code is up to date)

# --------------------------------------------------------------------- go ---

go-lint:
	cd $(SERVER_DIR) && $(GOLANGCI_LINT) run -c "$(CURDIR)/.golangci.yml" ./...
	cd $(HCTL_DIR) && $(GOLANGCI_LINT) run -c "$(CURDIR)/.golangci.yml" ./...

go-fmt:
	cd $(SERVER_DIR) && $(GOLANGCI_LINT) fmt -c "$(CURDIR)/.golangci.yml" --diff
	cd $(HCTL_DIR) && $(GOLANGCI_LINT) fmt -c "$(CURDIR)/.golangci.yml" --diff

go-test:
	cd $(SERVER_DIR) && $(GO) test ./... $(GO_RACE)
	cd $(HCTL_DIR) && $(GO) test ./... $(GO_RACE)
	cd $(GEN_GO_DIR) && $(GO) test ./...

# ------------------------------------------------------------------- rust ---

rust-fmt:
	cd $(TAURI_DIR) && $(CARGO) fmt --all -- --check

# The Tauri shell embeds client/ui/dist at compile time, so the UI is built
# first. `rostalk-core` (generated protocol types) is a workspace member.
rust-lint: ui-build
	cd $(TAURI_DIR) && $(CARGO) clippy --workspace --all-targets -- -D warnings

rust-test: ui-build
	cd $(TAURI_DIR) && $(CARGO) test --workspace

# Voice pipeline tests with file audio (no microphone or speakers). Runs on
# Windows only: the Tauri client ships there, and libwebrtc needs MSVC.
test-voice: ui-build
	cd $(TAURI_DIR) && $(CARGO) test -p rostalk-voice --features test-audio

# Measured quality gate (stage 2.3.1). Runs every test in
# tests/audio_quality.rs, ignored ones included: file-loop THD+N and continuity,
# NS attenuation, AEC ERLE, silence edges, two minutes of counter checks (one
# idle, one under CPU load), the two gap detectors with a drifting device
# clock (transmit since 2.3.2b, receive since 2.3.2c), the speech-based
# keyboard/fan test and the RNNoise CPU benchmark (stage 2.3.2e).
# `--include-ignored` is what puts the ignored measurements in the gate.
#
# The speech fixture is generated first; the keyboard/fan test skips itself
# with a message when the file is missing.
# Serial on purpose: parallel tests would compete for CPU and make the underrun
# assertions meaningless.
audio-fixtures:
	$(SPEECH_FIXTURE_PS) -File tools/audio-fixtures/make-speech.ps1

test-voice-quality: ui-build audio-fixtures
	cd $(TAURI_DIR) && $(CARGO) test -p rostalk-voice --features test-audio --test audio_quality -- --include-ignored --test-threads=1 --nocapture

# Regenerates the tauri-specta TypeScript bindings. The export needs a Windows
# application manifest, so the target runs the shell binary instead of a test
# harness; on Linux the Tauri shell is out of scope (design 1).
gen-ipc:
	cd $(TAURI_DIR) && $(CARGO) run --bin rostalk -- --export-bindings
	cd $(TAURI_DIR) && $(CARGO) run -p rostalk-server-setup -- --export-bindings

rust-bindings-check: gen-ipc
	git diff --exit-code -- $(UI_DIR)/src/core/tauri/bindings.ts $(UI_DIR)/src/server-setup/bindings.ts

# --------------------------------------------------------------------- ui ---

ui-deps: $(UI_DEPS_STAMP)

$(UI_DEPS_STAMP): $(UI_DIR)/package.json $(UI_DIR)/package-lock.json
	cd $(UI_DIR) && $(NPM) ci

ui-typecheck: ui-deps
	cd $(UI_DIR) && $(NPM) run typecheck

ui-lint: ui-deps
	cd $(UI_DIR) && $(NPM) run lint

ui-test: ui-deps
	cd $(UI_DIR) && $(NPM) test

ui-build: ui-deps
	cd $(UI_DIR) && $(NPM) run build

# ------------------------------------------------------------------ checks ---

# Anti-cheat hygiene from docs/anticheat.md ("Античит-гигиена"): the
# sources and the Windows dependency graph (tools/anticheat/check.sh), plus a
# self-test of the lint itself. Needs no build artifacts, so it belongs to
# `make check` on every platform. docs/anticheat.md explains both checks.
check-anticheat:
	"$(ANTICHEAT_SH)" tools/anticheat/check.sh
	"$(ANTICHEAT_SH)" tools/anticheat/selftest.sh

# Imports of the shipped binary. Windows only and deliberately not part of
# `make check`: it needs a release build (`make build-client`) and dumpbin.
# Both shipped executables: the client and the server installer (P13). Each
# needs its release build (`make build-client`, `make build-server-setup`).
check-anticheat-imports:
	$(ANTICHEAT_PS) -File tools/anticheat/imports.ps1 -ExePath client/src-tauri/target/release/rostalk.exe
	$(ANTICHEAT_PS) -File tools/anticheat/imports.ps1 -ExePath client/src-tauri/target/release/rostalk-server-setup.exe

check: proto-lint proto-format $(PROTO_BREAKING) go-lint go-fmt go-test \
	rust-fmt rust-lint rust-test $(RUST_VOICE) $(RUST_BINDINGS) ui-typecheck ui-lint ui-test verify-generated \
	check-anticheat

# Fast subset for the pre-commit hook: no builds, no tests.
precommit: proto-lint proto-format go-fmt rust-fmt
	git diff --check --cached

install-hooks:
	git config core.hooksPath .githooks

# ----------------------------------------------------------------- mutants ---
# Mutation testing answers one question: would the tests notice if this line
# were wrong? A survivor is a line no test protects. docs/TEST-QUALITY.md
# explains scope, time budget and how to read the score.
#
# These targets are deliberately NOT part of `make check`: one run takes tens of
# minutes, and a low score is a red flag for the reviewer rather than a build
# gate. Each tool is optional; the targets tell you how to install it.

CARGO_MUTANTS_VERSION := 27.1.0
GREMLINS_VERSION := v0.6.0
GREMLINS ?= gremlins
MUTANTS_GO_PACKAGES := perms roles chat state

ifeq ($(OS),Windows_NT)
# cmd.exe: NUL redirect, `&` inside parentheses, `exit /b`.
MUTANTS_REQUIRE = $(1) --version >NUL 2>&1 || (echo [mutants] $(2) is not installed. & echo [mutants] Install it: $(3) & exit /b 1)
else
MUTANTS_REQUIRE = $(1) --version >/dev/null 2>&1 || { echo "[mutants] $(2) is not installed."; echo "[mutants] Install it: $(3)"; exit 1; }
endif

mutants-rust:
	@$(call MUTANTS_REQUIRE,$(CARGO) mutants,cargo-mutants,cargo install cargo-mutants --version $(CARGO_MUTANTS_VERSION) --locked)
	cd $(TAURI_DIR) && $(CARGO) mutants --package rostalk-core -j1

# One package per run: gremlins copies and rebuilds the whole module for every
# run, so four packages in one command can exceed the time budget on its own.
mutants-go:
	@$(call MUTANTS_REQUIRE,$(GREMLINS),gremlins,go install github.com/go-gremlins/gremlins/cmd/gremlins@$(GREMLINS_VERSION))
	"$(SH)" tools/mutants/gremlins.sh perms
	"$(SH)" tools/mutants/gremlins.sh roles
	"$(SH)" tools/mutants/gremlins.sh chat
	"$(SH)" tools/mutants/gremlins.sh state

mutants-ui: ui-deps
	@$(if $(wildcard $(UI_DIR)/node_modules/@stryker-mutator/core/package.json),,$(error [mutants] StrykerJS is not installed. Run: cd client/ui and npm ci))
	cd $(UI_DIR) && $(NPM) run test:mutants

mutants-report:
	$(NODE) tools/mutants/report.mjs

mutants: mutants-rust mutants-go mutants-ui
	@echo All mutation runs finished. Run `make mutants-report` for the scores.

# ------------------------------------------------------------------- build ---

build-server:
	cd $(SERVER_DIR) && $(GO) build -trimpath -o ../bin/rostalk-server ./cmd/rostalk-server

# Release artefacts for linux/amd64 and linux/arm64, SHA256SUMS and its Ed25519
# signature (docs/INSTALL.md, deploy/release.sh). The server is Linux-only, so
# run this on Linux or in the golang container; ROSTALK_SIGN_KEY points at the
# offline private key.
release-server:
	sh deploy/release.sh

# The signed server bundle for rostalk-server-setup (P13; stage 6.1a shipped it
# with the client). Builds both Linux architectures from this commit with
# deploy/release.sh and copies the signed files to
# client/src-tauri/resources/server (ignored by git); `make release` puts them
# into the server installer zip, the SSH integration test reads them there.
server-bundle:
	"$(SH)" deploy/bundle-server.sh

# Portable Windows folder for hand-off: the release exe and a README. Since P13
# it carries no server/ (ADR 0026); `make release` zips the same layout.
client-portable:
	"$(SH)" deploy/portable-client.sh

# The Tauri CLI must be started from client/ (it looks for tauri.conf.json in
# the current directory and below, never above). --no-bundle skips installers,
# which belong to stage 6.2.
#
# Two Tauri applications live under client/ since P13 (ADR 0026), so every
# Tauri CLI call names its application with TAURI_APP_PATH instead of relying
# on the directory walk.
CLIENT_APP_PATH := $(CURDIR)/$(TAURI_DIR)
SETUP_APP_PATH := $(CURDIR)/$(TAURI_DIR)/apps/server-setup

build-client: export TAURI_APP_PATH := $(CLIENT_APP_PATH)
build-client: ui-deps
	cd client && $(NPM) --prefix ui exec -- tauri build --no-bundle

# The Windows server installer (P13): a portable exe without an installer.
# `make release` ships it in a zip next to the signed server bundle.
build-server-setup: export TAURI_APP_PATH := $(SETUP_APP_PATH)
build-server-setup: ui-deps
	cd client && $(NPM) --prefix ui exec -- tauri build --no-bundle

# The whole release in dist/release-$(VERSION) (ADR 0026, docs/RELEASE.md):
# client installer, portable client, server installer zip, Linux server
# binaries, install.sh, SHA256SUMS with its Ed25519 signature and latest.json.
# Keys stay outside the repository; Authenticode signing is optional and
# configured only through the environment (deploy/release-all.sh).
release: export ROSTALK_RELEASE_REPO := $(RELEASE_REPO)
release: export RELEASE_VERSION := $(VERSION)
release: ui-deps
	"$(SH)" deploy/release-all.sh

# Uploads dist/release-$(VERSION) to GitHub with the maintainer's gh login.
# DRY_RUN=1 prints the gh commands without sending anything.
publish-release: export ROSTALK_RELEASE_REPO := $(RELEASE_REPO)
publish-release: export RELEASE_VERSION := $(VERSION)
publish-release: export DRY_RUN := $(DRY_RUN)
publish-release:
	"$(SH)" deploy/publish-release.sh

# Stage 6.2: the Windows installer (`NSIS`, currentUser) and its updater
# signature. The private key is never in the repository; it is read from
# %USERPROFILE%\.rostalk\release\rostalk-updater.key unless
# TAURI_SIGNING_PRIVATE_KEY is already set. The public key is in
# tauri.conf.json. Run `make build-client` first for the plain release exe and
# `make check-anticheat-imports` after this target.
ifeq ($(OS),Windows_NT)
release-client: ui-deps
	@if not exist "$(subst /,\,$(UPDATER_KEY))" (echo release-client: updater private key not found at "$(UPDATER_KEY)" & echo Run: make release-key & exit /b 1)
	set "TAURI_APP_PATH=$(subst /,\,$(CLIENT_APP_PATH))" && set "TAURI_SIGNING_PRIVATE_KEY=$(subst /,\,$(UPDATER_KEY))" && cd client && $(NPM) --prefix ui exec -- tauri build

# Generates the update signing keypair once. The private key is written outside
# the repository; the public key must be copied to tauri.conf.json.
release-key:
	cd client && $(NPM) --prefix ui exec -- tauri signer generate -w "$(subst /,\,$(UPDATER_KEY))" --ci
else
release-client:
	@echo The RosTalk client installer is Windows-only (NSIS).
	@exit 1

release-key:
	@echo The update signing key is generated on Windows with the Tauri CLI.
	@exit 1
endif

# --------------------------------------------------------------------- dev ---

dev-server:
	cd $(SERVER_DIR) && $(GO) run ./cmd/rostalk-server run --data=../data

dev-client: export TAURI_APP_PATH := $(CLIENT_APP_PATH)
dev-client: ui-deps
	cd client && $(NPM) --prefix ui exec -- tauri dev

dev-server-setup: export TAURI_APP_PATH := $(SETUP_APP_PATH)
dev-server-setup: ui-deps
	cd client && $(NPM) --prefix ui exec -- tauri dev

# Thin wrappers: the same commands work on Windows without make, WSL or Go.
dev-server-docker:
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) up --build

test-server-docker:
	$(DOCKER_COMPOSE) -f $(COMPOSE_FILE) --profile test run --rm --build test

# install.sh must work on the three supported distro families. Not part of
# `make check` because it pulls container images; run it before a release.
test-install-docker:
	sh deploy/test-install-docker.sh

# Full SSH installation against a throwaway ubuntu container with sshd. The
# Rust test is #[ignore] so `make check` stays fast; this target builds the
# bundle, starts the container and runs the test.
test-client-install-docker:
	"$(SH)" deploy/test-client-install-docker.sh

# Media check from a Windows host (gate G3, ADR 0001): two rostalkctl bots on the
# host talk to the dev server in Docker Desktop over UDP. Needs a running dev
# server and ROSTALK_ADVERTISE_IP set to the LAN IP of the host.
check-media:
	powershell -NoProfile -ExecutionPolicy Bypass -File deploy/dev/check-media.ps1 -AdvertiseIP "$(ROSTALK_ADVERTISE_IP)"
