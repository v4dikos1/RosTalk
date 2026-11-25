# Test quality: coverage is not the goal

`make check` answers "do the tests pass?". Mutation testing answers a harder
question: **would the tests fail if this line were wrong?** A mutant is a small
deliberate bug (`>` → `>=`, `||` → `&&`, a removed `!`, a dropped match arm).
If the suite still passes, the line is not protected by any assertion.

This document records the tools, the measured baseline, the thresholds and what
to do with a survivor. It is a quality signal for the reviewer, not a build
gate: nothing here runs inside `make check`.

## Tools and scope

| Area | Tool | Version | Scope |
| --- | --- | --- | --- |
| Rust core | [`cargo-mutants`](https://mutants.rs) | 27.1.0 | `client/src-tauri/crates/core/src/{link,error,model,state,settings}.rs`, `--lib` unit tests only |
| Go server | [`gremlins`](https://gremlins.dev) | v0.6.0 | `server/internal/{perms,roles,chat,state}`, one package per run |
| UI | [`StrykerJS`](https://stryker-mutator.io) with the Vitest runner | 10.1.1 | `client/ui/src/lib/*.ts(x)` and `src/store/*.ts` with unit tests, explicit file list in `stryker.config.mjs` |

Deliberately out of scope:

- `client/src-tauri/crates/voice` — C++/libwebrtc, one mutant run costs minutes
  and the audio pipeline is covered by the measured `test-voice-quality` gate.
- `crates/core/tests/server_integration.rs`, `server/internal/integration`,
  Playwright — integration tests start real servers/browsers. Mutation runs need
  a sub-second unit suite to stay inside the budget.
- UI components and pages — mostly rendering assertions; mutating them produces
  mostly equivalent or styling mutants for a large time cost.

All three tools are optional developer tools. They are not build dependencies
and do not ship in the client: `@stryker-mutator/*` are `devDependencies` of
`client/ui`, `cargo-mutants` is a separate `cargo install`, `gremlins` a
separate `go install`. None of them is linked into the release binary or
touches the anti-cheat surface (`make check-anticheat` is unaffected).

## How to run

Install once:

```sh
cargo install cargo-mutants --version 27.1.0 --locked
go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0   # puts gremlins in $(go env GOPATH)/bin
cd client/ui && npm ci                                          # pulls the Stryker devDependencies
```

Then, from the repository root:

```sh
make mutants-rust     # client core, all five modules (~35-45 min on a 6-core laptop)
make mutants-go       # four server packages (~6 min)
make mutants-ui       # UI logic, five files, static mutants skipped (~5-8 min)
make mutants          # all three, sequentially
make mutants-report   # one table from the last reports, no tool run
```

Narrower runs while iterating (the tools append filters to their config, so
these do not need config edits):

```sh
cd client/src-tauri && cargo mutants --package rostalk-core --shard 0/4
cd server && gremlins unleash ./internal/perms
cd client/ui && npx stryker run --mutate src/lib/link.ts
```

`gremlins` must be on `PATH`; if it is not, pass the binary explicitly:
`make mutants-go GREMLINS="$(go env GOPATH)/bin/gremlins"`.

### Time budget

A mutation run is only useful if it finishes in a coffee break. The hard limits:

- **15-20 minutes per tool invocation** on the reference machine (6 cores,
  Windows). A run that would exceed it is split with `--shard` (Rust) or by
  package/file (Go, UI).
- The whole configured Rust scope is ~45 minutes, so it is normally run per file
  or in shards, not in one go.
- `cargo-mutants` is run with `-j1`: each mutant already builds with all cores,
  and 3 parallel mutant builds on a 6-core machine made individual builds six
  times slower (measured). Parallelism only helps on much larger machines.
- UI mutants default to `concurrency: 4`; raise it on a bigger machine or lower
  it to keep the laptop responsive.

## How to read the score

The tools count differently, so compare scores within an area, not across tools.

| Tool | Score formula | Notes |
| --- | --- | --- |
| cargo-mutants | `caught / (caught + missed + timeout)` | `unviable` mutants (the mutation does not compile) are excluded |
| gremlins | `killed / (killed + lived)` | this is gremlins' "test efficacy"; `not covered` mutants are outside the denominator |
| Stryker | `(killed + timeout) / (killed + timeout + survived + no coverage)` | compile/runtime errors are excluded |

A timeout counts as killed: the mutation made the suite hang, which is a
detected defect.

Thresholds for the scoped modules above (**red flag, not a blocker**):

| Score | Meaning |
| --- | --- |
| ≥ 80 % | strong: the module is protected by real assertions |
| 60-79 % | acceptable for critical logic; look at the survivors list |
| 40-59 % | yellow flag: important branches are unprotected |
| < 40 % | red flag: the tests mostly execute code without checking it |

60 % is the target for anything that decides permissions, validation or state
transitions. A drop below it in a PR that touches such a module deserves a
review comment, not a build failure. Scores fluctuate with tool versions and
scope; the number that matters is the *trend* and the *survivor list*.

## What to do with a survivor

1. Read the mutation. Ask what behaviour would change for a user.
2. If the behaviour matters, add a test that asserts **that behaviour** (a
   boundary value, an error code, an ordering, a rejected input). Never write a
   test whose only purpose is to touch the mutated line.
3. If the mutant is **equivalent** (no observable behaviour change), leave it.
   Typical cases: defensive checks that a later validation also rejects, a
   redundant locale branch, a `>=`/`>` split that cannot occur because the value
   is bounded elsewhere. Record it in the table below instead of contorting the
   tests.
4. If a whole area is untested, do not chase single mutants: write the missing
   behaviour tests first and re-run.

The rule from `CONTRIBUTING.md` applies: tests are added, product behaviour is not
changed to make a mutants run green.

## Baseline

Measured on 2026-11-22 from `stage/m2-preview` @ `5252988` (before the tests
below were added), Windows 11, i5-12400F (6 cores / 12 threads). Runs were
sequential and nothing else compiled in parallel, except where noted.

Score definitions are above; `unviable` means the mutant did not compile, and
`no cov` is code no test even executed (gremlins/Stryker only; cargo-mutants
still generates those mutants and marks them `missed`).

| Area | Tool | Mutants | Killed | Timeout | Survived | No cov | Unviable | Score | Wall time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Rust `link.rs` | cargo-mutants 27.1.0 | 64 | 41 | 0 | 16 | - | 7 | 71.9 % | 8 min |
| Rust `error.rs` + `model.rs` | cargo-mutants 27.1.0 | 37 | 15 | 0 | 6 | - | 16 | 71.4 % | 5 min |
| Rust `state.rs` | cargo-mutants 27.1.0 | 94 | 48 | 0 | 25 | - | 21 | 65.8 % | 19 min |
| Rust `settings.rs` | cargo-mutants 27.1.0 | 82 | 55 | 0 | 20 | - | 7 | 73.3 % | 15 min |
| Go `internal/perms` | gremlins v0.6.0 | 36 | 26 | 0 | 0 | 10 | 0 | 100 % efficacy / 72 % coverage | 1 min |
| Go `internal/roles` | gremlins v0.6.0 | 109 | 58 | 0 | 0 | 51 | 0 | 100 % / 53 % | 2 min |
| Go `internal/chat` | gremlins v0.6.0 | 251 | 198 | 0 | 0 | 53 | 0 | 100 % / 79 % | 2 min |
| Go `internal/state` | gremlins v0.6.0 | 76 | 65 | 0 | 0 | 11 | 0 | 100 % / 86 % | 2 min |
| UI `link.ts` | StrykerJS 10.1.1 | 117 | 76 | 0 | 33 | 8 | 0 | 65.0 % | 10 min |
| UI first wave (5 files, see below) | StrykerJS 10.1.1 | 594 | 413 | 0 | 94 | 87 | 0 | 69.5 % | 5 min (one run) |

Reading the numbers:

- **Go efficacy is 100 % while half the code is not covered.** gremlins only
  mutates lines the tests execute, so "efficacy" says "every covered line is
  asserted" and says nothing about the 51 untested mutants in `roles`. Always
  read efficacy together with mutator coverage; a 100 % / 53 % row is a gap, not
  a trophy.
- **cargo-mutants' "unviable" rate is high** (51 of 277) because the model types
  do not implement `Default`, so the `-> Default::default()` mutants do not
  compile. That is normal and excluded from the score.
- **The UI `link.ts` parser was the weakest logic module in the baseline**
  (65 %): it has many error returns and the old tests checked the happy path plus
  one generic error, so several `if`/`return` mutants produced the same result
  for the inputs they tried. In the first wave, `coreStore.ts` is the weak spot
  (45.5 %): its mutants are mostly not executed at all.

### Top survivors (before the tests below)

Rust `link.rs` — 16 missed, almost all in `validate_hostname`:

| Mutation | Why the suite missed it |
| --- | --- |
| `validate_hostname` body → `Ok(())` | nothing tested an invalid DNS name |
| `>` → `==`/`>=` on `host.len() > 253`, `label.len() > 63` | no host at the 253/254 or 63/64 boundary |
| `&&`/`||` and `-` index checks in the label loop | no leading/trailing hyphen, `..`, underscore or non-ASCII host |
| `authority`/`parse_host` separator `||` → `&&` | later hostname validation rejects the same inputs; effectively equivalent |
| credentials check `||` → `&&` | tests never sent a link with only a username or only a password |

Rust `error.rs` + `model.rs` — 6 missed: `Display` output never asserted; the
`LoginMode` and `VoiceProfile` match arms (UI contract) never exercised;
`unread_views` never called.

Rust `state.rs` — 25 missed: unread counters keyed by both ids, `server_name`,
`own_channel_id` fallback, `set_active_server`, in-place updates by id, and
`last_connected_unix_ms` were not asserted. The `BookmarkStore::open` NotFound
guard is effectively equivalent (both branches return an empty store; only the
log line differs).

Rust `settings.rs` — 20 missed: `LocalePreference::tag`/`HotkeyAction::id`
strings, the nickname length boundary, the legacy gate/import branches of
`parse_settings`, `reset_onboarding`, and participant dedup.

UI `link.ts` — 33 survived, dominated by:

| Mutation | Why the suite missed it |
| --- | --- |
| `if (url.protocol !== "rostalk:")` → `if (false)` | the only non-rostalk test was `https://example.com`, rejected later as "not join" anyway |
| `if (action !== "join")` → `if (false)` | no `rostalk://other?...` test |
| `FINGERPRINT` regex losing `^`/`$` | every malformed fingerprint tested was the wrong length, not 64 hex inside a longer string |
| `?.[trim]` on host/fingerprint removed | no host or `fp` with surrounding spaces |
| `invite`/`password` empty-string handling | no empty `invite` and no `password` parameter at all |
| `isLoopbackHost` `::1` / `[::1]` alternatives | only `localhost` and `127.0.0.1` were tested |
| `shortFingerprint` `<= 20` boundary | only a 64-character fingerprint was tested |

## Cheap survivors closed

All added tests assert behaviour, not a mutation. `git show` on the branch has
the exact diffs; the counts below are the re-run on the same tool versions.

| Area | Tests added | What they protect | Before → after |
| --- | --- | --- | --- |
| Rust `link.rs` | 3 | credentials in either URL half; DNS label/host length boundaries (63/64, 253/254), hyphen/underscore/non-ASCII/double-dot; IPv6 suffix and port 0 | 71.9 % → 96.5 % |
| Rust `error.rs` + `model.rs` | 5 | `Display` format; login-mode and voice-profile wire mapping; unrounded `unread_views`; channel/user ordering keys (parent, position, name, id; case-insensitive nickname) | 71.4 % → 100 % |
| Rust `state.rs` | 5 | unread key (channel **and** peer); in-place user/channel updates by id; `server_name`/`own_channel_id`/`set_active_server`; nickname saved for a known server; plausible connection timestamp | 65.8 % → 89.0 % |
| Go `internal/perms` | 2 | `CanCreateRole` strict-position boundaries; unknown/unspecified permissions are never granted; `AllMask` shape | 100 % efficacy, 72.2 % coverage → 100 %, 83.3 % (26 → 30 killed) |
| UI `link.ts` | 6 cases | protocol and action checks in isolation; fingerprint anchors; host/`fp` trimming; empty invite and password parameter; all loopback forms; `shortFingerprint` 20/21 boundary | 65.0 % → 82.3 % (after excludes 4 static mutants) |
| UI `time.ts` | 2 | year in an older date label; `formatDuration` floor/clamp and padding | first measurement 68.4 % |

Across the whole configured Rust scope the score is **70.4 % → 86.7 %** (settings
unchanged, so its baseline still counts). The two remaining Rust survivors in
`link.rs` are the equivalent `parse_host` separator checks.

Tests that did **not** move the score are still useful: they pin behaviour the
mutator cannot express (for example the exact error code for an empty invite).
A mutant that survives the tests is equivalent or defensive and is documented
above instead of being chased.

### UI first wave, per file

Measured after the tests above were added, with `ignoreStatic` (see below), one
file per run to stay inside the budget. Static mutants are counted separately:
`permissions.ts` has 134, `coreStore.ts` 8, `link.ts` 4. They are outside the
score.

| File | Mutants | Killed | Survived | No cov | Score | Time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/lib/link.ts` | 113 | 93 | 16 | 4 | 82.3 % | 1.4 min |
| `src/lib/permissions.ts` | 123 | 96 | 25 | 2 | 78.0 % | 1.5 min |
| `src/lib/quality.ts` | 87 | 79 | 8 | 0 | 90.8 % | 36 s |
| `src/lib/time.ts` | 95 | 65 | 23 | 7 | 68.4 % | 53 s |
| `src/store/coreStore.ts` | 176 | 80 | 22 | 74 | 45.5 % | 2.5 min |
| **Total** | **594** | **413** | **94** | **87** | **69.5 %** | ~7 min |

`coreStore.ts` is the red flag: 74 of its mutants are never executed by the
current store tests (the store is mostly tested through components), so its
45.5 % is really "the mirror is not unit-tested". It is the next UI target, not
a reason to add tests for single mutants.

### Settings: measured, not yet closed

`settings.rs` is the one Rust module in scope where no test was added in this
pass: its 20 survivors are listed above and are mostly legacy-migration branches
and identifier strings. They are real gaps; closing them needs a new after-run
(15 min) and is left as the next step so this branch stays reviewable.

## Why this is not in `make check`

- One full run costs tens of minutes; `make check` must stay a fast local gate.
- The tools are optional and platform-specific (gremlins has a Windows temp-dir
  quirk, `cargo-mutants` needs a Rust build, Stryker pulls dev npm packages).
- A low score is a judgement call, not a pass/fail. Equivalent mutants are
  normal, and gating on the number teaches people to game it.
- Mutation runs are for the reviewer and for the author of a risky change
  (permissions, validation, state machine), not for every commit.

The reviewer may ask for a mutants run on the touched module; the report table
in the PR description is enough.

## Known limitations

- **cargo-mutants config merging.** `--file` on the command line is *appended*
  to `examine_globs` from `.cargo/mutants.toml`, so it cannot narrow the
  configured scope. Use `--config` with a temporary config or `--shard` instead.
- **gremlins on Windows** sometimes cannot delete its temporary module copy and
  exits 1 *after* writing a complete report. `tools/mutants/gremlins.sh` treats
  an existing report as success; the message says so.
- **Stryker static mutants** (module-level constants and regexes) need a full
  test-file reload per mutant. In `permissions.ts` they were 52 % of the mutants
  and an estimated 99 % of the runtime, so `ignoreStatic` is on. They are still
  covered by ordinary value assertions; the report shows them as "ignored" and
  they are outside the score.
- **One Stryker run per file** is the reliable shape on Windows: a combined run
  of all five files (740 mutants) exceeded the budget, and Node 25 once crashed
  in Stryker's `taskkill` of a stuck vitest child at 43 %. The per-file reports
  are merged by `make mutants-report` only for reading; `make mutants-ui` runs
  the configured list in one process, which now finishes because static mutants
  are skipped.
- Go `internal/state` has concurrent tests; a mutation that changes timing can
  produce a timeout rather than a clean failure. Timeouts are counted as killed.
- The UI scope is logic only. React components, i18n strings and CSS are not
  mutated and should be covered by review and the Playwright smoke run.
