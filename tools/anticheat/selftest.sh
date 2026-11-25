#!/bin/sh
# Tests the anti-cheat lint itself (stage 2.3.3).
#
# 1. On the real tree `check.sh` passes.
# 2. A temporary source file with `SetWindowsHookExW`, `SendInput`,
#    `NtReadVirtualMemory`, `CreateServiceW`, `chromeMediaSource` and
#    `unsafe-eval` makes it fail, with the file and the line reported.
# 3. A temporary file where the same API only appears in a comment passes: a
#    comment cannot install a hook, and the client documents the bans that way.
# 4. The temporary files are removed; the repository is left untouched.
#
# Runs in Git Bash and in bash on Linux, like check.sh. Exit codes: 0 the lint
# behaves as documented, 1 it does not, 2 the test could not run.

set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || exit 2
cd "$repo_root" || exit 2

check=$script_dir/check.sh
probe_dir=client/src-tauri/crates/platform/src
probe=$probe_dir/anticheat-selftest-probe.rs
comment_probe=$probe_dir/anticheat-selftest-comment.rs

if [ ! -f "$check" ]; then
    printf 'selftest: FAILED — %s not found\n' "$check"
    exit 2
fi
if [ ! -d "$probe_dir" ]; then
    printf 'selftest: FAILED — %s not found\n' "$probe_dir"
    exit 2
fi
if [ -e "$probe" ] || [ -e "$comment_probe" ]; then
    printf 'selftest: FAILED — %s or %s already exists, remove it first\n' "$probe" "$comment_probe"
    exit 2
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/rostalk-anticheat-selftest.XXXXXX") || {
    printf 'selftest: FAILED — cannot create a temporary directory\n'
    exit 2
}
output=$tmp_dir/check.log

cleanup() {
    rm -f "$probe" "$comment_probe"
    rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

fail() {
    printf 'selftest: FAILED — %s\n' "$1"
    if [ -f "$output" ]; then
        printf '%s\n' '--- check.sh output ---'
        sed 's/^/    /' "$output"
        printf '%s\n' '--- end ---'
    fi
    exit 1
}

printf 'selftest: the real tree must pass\n'
if ! sh "$check" >"$output" 2>&1; then
    fail "check.sh rejected the current tree"
fi

printf 'selftest: a banned API in code must fail\n'
cat >"$probe" <<'EOF'
// Temporary file written by tools/anticheat/selftest.sh.
pub fn anticheat_selftest_probe() {
    let _ = SetWindowsHookExW;
    let _ = SendInput;
    // Direct NT memory access, a kernel service and two updater/capture
    // regressions added in the 2026-11-22 audit.
    let _ = NtReadVirtualMemory;
    let _ = CreateServiceW;
    let _ = "chromeMediaSource";
    let _ = "unsafe-eval";
}
EOF
if sh "$check" >"$output" 2>&1; then
    fail "check.sh accepted $probe"
fi
grep -q "SetWindowsHookExW" "$output" || fail "the report does not name SetWindowsHookExW"
grep -q "SendInput" "$output" || fail "the report does not name SendInput"
grep -q "NtReadVirtualMemory" "$output" || fail "the report does not name NtReadVirtualMemory"
grep -q "CreateServiceW" "$output" || fail "the report does not name CreateServiceW"
grep -q "chromeMediaSource" "$output" || fail "the report does not name chromeMediaSource"
grep -q "unsafe-eval" "$output" || fail "the report does not name unsafe-eval"
grep -q "anticheat-selftest-probe.rs" "$output" || fail "the report does not name the file"
rm -f "$probe"

printf 'selftest: a ban mentioned only in a comment must pass\n'
cat >"$comment_probe" <<'EOF'
// Temporary file written by tools/anticheat/selftest.sh.
// The ban list itself names SetWindowsHookExW and SendInput; documenting the
// ban is not using it (see the header of tools/anticheat/check.sh).
pub fn anticheat_selftest_comment() {}
EOF
if ! sh "$check" >"$output" 2>&1; then
    fail "check.sh rejected a comment-only mention"
fi
rm -f "$comment_probe"

printf 'selftest: OK — the lint passes the tree, catches hooks, synthetic input, direct NT memory access, a service and the capture/eval regressions, and ignores comments\n'
exit 0
