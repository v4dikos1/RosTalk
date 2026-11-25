#!/bin/sh
# RosTalk anti-cheat lint (stage 2.3.3).
#
# Checks the rules of "Античит-гигиена" (docs/anticheat.md) that can
# be verified from the sources alone:
#
#   1. every regexp from tools/anticheat/denylist.txt is absent from the client
#      sources (client/src-tauri without target/, gen/ and the generated
#      protocol types, plus client/ui/src);
#   2. the Windows dependency graph (cargo tree) has no forbidden crate.
#
# Exceptions live in tools/anticheat/allowlist.txt, one per line, in the form
# `path:regexp # ADR NNNN`. `path` is a shell glob, `regexp` is matched against
# the offending source line, and the ADR note is mandatory: an exception
# without a decision record is not an exception. Entries are approved by a
# human (CONTRIBUTING.md), so this file is expected to stay empty unless something is
# genuinely allowed by an ADR.
#
# Whole-line comments do not count as usage: the client documents the bans
# (for example `hotkey.rs` lists the forbidden `RIDEV_*` flags in a doc
# comment), and a comment cannot install a hook. check.sh skips lines that
# start with `//`, `/*` or `*/` (Rust, TypeScript) and with `#` in TOML.
#
# The script is POSIX sh and runs in Git Bash on Windows and in bash on Linux.
# It writes nothing into the repository and needs no build artifacts: the
# executable import check is a separate Windows-only target
# (`make check-anticheat-imports`, docs/anticheat.md).
#
# Exit codes: 0 clean, 1 violation, 2 the check itself could not run.

set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || exit 2
cd "$repo_root" || exit 2

DENYLIST=${ROSTALK_DENYLIST:-tools/anticheat/denylist.txt}
ALLOWLIST=${ROSTALK_ALLOWLIST:-tools/anticheat/allowlist.txt}
TARGET=${ROSTALK_ANTICHEAT_TARGET:-x86_64-pc-windows-msvc}
CARGO=${CARGO:-cargo}

if [ ! -f "$DENYLIST" ]; then
    printf 'anti-cheat: FAILED — %s not found (run from the repository)\n' "$DENYLIST"
    exit 2
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/rostalk-anticheat.XXXXXX") || {
    printf 'anti-cheat: FAILED — cannot create a temporary directory\n'
    exit 2
}
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

hits_file=$tmp_dir/hits
tree_file=$tmp_dir/tree
tree_err=$tmp_dir/tree.err
crates_file=$tmp_dir/crates
crate_report=$tmp_dir/crates.report
stats_file=$tmp_dir/crates.stats
rules_file=$tmp_dir/rules

rules=0
packages=0
violations=0
allowed=0

trim_spaces() {
    trimmed=$1
    trimmed=${trimmed#"${trimmed%%[![:space:]]*}"}
    trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
    printf '%s' "$trimmed"
}

# A whole-line comment documents a ban, it does not use the API.
is_comment_line() {
    comment_file=$1
    comment_text=$2
    case "$comment_file" in
        *.toml)
            case "$comment_text" in
                '#'*) return 0 ;;
            esac
            return 1
            ;;
    esac
    case "$comment_text" in
        '//'* | '/*'* | '*/'*) return 0 ;;
    esac
    return 1
}

# 0 when the hit is covered by an allowlist entry that names an ADR.
allowlist_match() {
    allowed_file=$1
    allowed_text=$2
    [ -f "$ALLOWLIST" ] || return 1
    while IFS= read -r entry; do
        case "$entry" in
            '' | '#'*) continue ;;
        esac
        entry=$(trim_spaces "$entry")
        # `path:regexp # ADR NNNN` — the ADR note is mandatory.
        case "$entry" in
            *:*' # '*) ;;
            *) continue ;;
        esac
        entry_path=${entry%%:*}
        entry_rest=${entry#*:}
        entry_regexp=${entry_rest%% # *}
        entry_note=${entry_rest#* # }
        # shellcheck disable=SC2254 # the path is a glob on purpose
        case "$allowed_file" in
            $entry_path) ;;
            *) continue ;;
        esac
        if printf '%s\n' "$allowed_text" | grep -qE -- "$entry_regexp"; then
            allowed=$((allowed + 1))
            printf 'ALLOWED %s  (%s)\n         %s\n' "$allowed_file" "$entry_note" "$allowed_text"
            return 0
        fi
    done <"$ALLOWLIST"
    return 1
}

collect_rules() {
    # One regexp per line, comments and blank lines removed, so that the list
    # can be passed to `grep -f` as is.
    grep -vE '^[[:space:]]*(#|$)' "$DENYLIST" | while IFS= read -r raw_rule; do
        trimmed=$(trim_spaces "$raw_rule")
        [ -n "$trimmed" ] || continue
        printf '%s\n' "$trimmed"
    done >"$rules_file"
    rules=$(grep -c '' "$rules_file")
}

source_line() {
    # $1 = file, $2 = 1-based line number; CRLF checkouts are common on Windows.
    sed -n "$2p" "$1" 2>/dev/null | tr -d '\r'
}

scan_sources() {
    # One grep with every rule. Reporting the matched text (not the rule) keeps
    # this a single process: a per-rule grep costs a minute on Git Bash.
    {
        # Build artifacts and generated protocol types are not our source.
        grep -rnIEo -f "$rules_file" --exclude-dir=target --exclude-dir=gen \
            --exclude-dir=node_modules --exclude-dir=proto -- client/src-tauri
        grep -rnIEo -f "$rules_file" --exclude-dir=node_modules -- client/ui/src
    } 2>/dev/null | LC_ALL=C sort -u >"$hits_file"

    while IFS= read -r hit; do
        [ -n "$hit" ] || continue
        hit_file=${hit%%:*}
        hit_rest=${hit#*:}
        hit_line=${hit_rest%%:*}
        hit_match=${hit_rest#*:}
        hit_text=$(trim_spaces "$(source_line "$hit_file" "$hit_line")")
        if is_comment_line "$hit_file" "$hit_text"; then
            continue
        fi
        if allowlist_match "$hit_file" "$hit_text"; then
            continue
        fi
        violations=$((violations + 1))
        printf 'FAIL %s:%s\n     match: %s\n     code:  %s\n' \
            "$hit_file" "$hit_line" "$hit_match" "$hit_text"
    done <"$hits_file"
}

scan_dependencies() {
    # A bare lowercase identifier in the denylist is a crate name as well.
    grep -E '^[a-z][a-z0-9_-]*$' "$DENYLIST" >"$crates_file" 2>/dev/null || true

    if ! command -v "$CARGO" >/dev/null 2>&1; then
        printf 'FAIL cargo not found: %s is needed for the dependency check\n' "$CARGO"
        violations=$((violations + 1))
        return
    fi

    # `-e normal` is the shipped dependency graph; build and dev dependencies
    # never end up in the client binary. `--workspace` covers every shipped
    # application: the client and, since P13, rostalk-server-setup (ADR 0026).
    if ! "$CARGO" tree --manifest-path client/src-tauri/Cargo.toml --workspace -e normal \
        --target "$TARGET" --prefix none --format '{p}' >"$tree_file" 2>"$tree_err"; then
        printf 'FAIL cargo tree failed for target %s:\n' "$TARGET"
        sed 's/^/     /' "$tree_err"
        violations=$((violations + 1))
        return
    fi

    # One awk pass over 1200 packages: a shell loop with a process per line
    # takes minutes in Git Bash.
    LC_ALL=C awk -v stats="$stats_file" '
        FILENAME == ARGV[1] { banned[$0] = 1; next }
        NF == 0 { next }
        $0 in seen { next }
        {
            seen[$0] = 1
            lower = tolower($1)
            alt = lower
            gsub(/-/, "_", alt)
            total++
            if (lower in banned || alt in banned) {
                print "FAIL forbidden crate in the dependency graph: " $0
            }
        }
        END { print total > stats }
    ' "$crates_file" "$tree_file" >"$crate_report" 2>/dev/null

    packages=0
    if [ -f "$stats_file" ]; then
        read -r packages <"$stats_file"
    fi
    if [ -s "$crate_report" ]; then
        while IFS= read -r crate_fail; do
            violations=$((violations + 1))
            printf '%s\n' "$crate_fail"
        done <"$crate_report"
    fi
}

printf 'anti-cheat: source rules from %s\n' "$DENYLIST"
collect_rules
if [ "$rules" -eq 0 ]; then
    printf 'anti-cheat: FAILED — %s has no rules, the lint would pass everything\n' "$DENYLIST"
    exit 2
fi
scan_sources
printf 'anti-cheat: dependency graph from cargo tree -e normal --target %s\n' "$TARGET"
scan_dependencies

if [ "$violations" -ne 0 ]; then
    printf '\nanti-cheat: FAILED — %s violation(s).\n' "$violations"
    printf 'Fix the code, or add a justified exception to %s as\n' "$ALLOWLIST"
    printf '`path:regexp # ADR NNNN` with the ADR that allows it.\n'
    exit 1
fi

printf 'anti-cheat: OK — %s rules, %s packages in the Windows graph' "$rules" "$packages"
if [ "$allowed" -ne 0 ]; then
    printf ', %s allowlisted hit(s)' "$allowed"
fi
printf '.\n'
exit 0
