#!/usr/bin/env bash
#
# The one ratchet runner. Seven baselines in this repo (dead code, file size,
# shared production exports, query authz, session threading, boolean naming,
# token redaction) all want the SAME comparison, and each check script used
# to carry its own copy of it — same `comm -23` / `comm -13` pair, same
# `--write-baseline`, same off-by-one traps, drifting in the details (three of
# them forgot LC_ALL=C, three had no missing-baseline guard, four had no
# --write-baseline at all). This script owns that comparison; a check script
# owns only its generator and its wording.
#
#   scripts/ratchet.sh [options] -- <generator command …>
#
# The generator prints the CURRENT violation set, one entry per line, on stdout
# and exits 0 (a non-zero exit aborts the ratchet with that status, so a
# generator can fail loudly — knip not installed, tree missing — instead of
# reporting an empty set as "everything got fixed"). Duplicate lines are
# significant and preserved: check-boolean-naming.sh relies on `comm` pairing
# repeats so the same bad field name on a second table is still caught. If a
# generator wants uniqueness it sorts with `sort -u` itself.
#
# The comparison is strict in BOTH directions, which is the whole point of a
# ratchet:
#   * an entry NOT in the baseline fails — a regression, fix it, do not add a
#     baseline line, and
#   * a baseline entry the generator no longer reports fails as stale — delete
#     the line, so the debt count only ever moves down.
#
# Options:
#   --baseline <path>     baseline file, relative to the caller's cwd (required)
#   --ok <text>           green line: "ok:   <text> (N baseline entries remain)"
#   --new-header <tmpl>   first line of the regression block
#   --new-advice <text>   how to fix a regression (printed after the entries)
#   --stale-header <tmpl> first line of the stale block
#   --stale-advice <text> printed after the stale entries
#   --seed <cmd>          command suggested when the baseline file is missing
#   --stderr              write failure blocks to stderr instead of stdout
#   --write-baseline      re-seed the baseline from the generator instead of
#                         comparing (any leading `#` comment header is kept)
#
# Templates expand {n} (the entry count) and {baseline} (the baseline path).
#
# Blank lines and `#` comments in a baseline are ignored, so a baseline may
# document itself. Both sides of every comparison are sorted with LC_ALL=C
# because `comm` compares bytes while `sort` honours LC_COLLATE: under a UTF-8
# locale the two disagree about where `_`, `.` and `/` fall in a path, and comm
# then reports the same entry as both new AND stale.

set -uo pipefail

baseline=""
ok_text="no new entries"
new_header="FAIL: {n} new entr(y/ies) not in {baseline}:"
new_advice="Fix them. Do NOT add new lines to {baseline}; it is frozen debt."
stale_header="FAIL: {n} stale entr(y/ies) in {baseline}:"
stale_advice="Delete these lines so the ratchet only moves down."
seed_cmd=""
write_baseline=0
to_stderr=0

usage() {
	echo "ratchet.sh: $*" >&2
	echo "usage: scripts/ratchet.sh --baseline <path> [options] -- <generator command …>" >&2
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
		--baseline | --ok | --new-header | --new-advice | --stale-header | --stale-advice | --seed)
			[ $# -ge 2 ] || usage "$1 needs a value"
			case "$1" in
				--baseline) baseline="$2" ;;
				--ok) ok_text="$2" ;;
				--new-header) new_header="$2" ;;
				--new-advice) new_advice="$2" ;;
				--stale-header) stale_header="$2" ;;
				--stale-advice) stale_advice="$2" ;;
				--seed) seed_cmd="$2" ;;
			esac
			shift 2
			;;
		--write-baseline)
			write_baseline=1
			shift
			;;
		--stderr)
			to_stderr=1
			shift
			;;
		--)
			shift
			break
			;;
		*) usage "unknown option $1" ;;
	esac
done

[ -n "$baseline" ] || usage "--baseline is required"
[ $# -gt 0 ] || usage "no generator command after --"

# {n} / {baseline} substitution. Deliberately not printf: the message bodies
# contain literal % characters (percentages, awk snippets) that printf would
# eat.
render() {
	local text="$1"
	text="${text//\{n\}/${2:-}}"
	printf '%s\n' "${text//\{baseline\}/$baseline}"
}

say() {
	if [ "$to_stderr" -eq 1 ]; then
		printf '%s\n' "$1" >&2
	else
		printf '%s\n' "$1"
	fi
}

# Non-empty, non-comment lines only — in C collation, the one `comm` speaks.
entries() { grep -v '^[[:space:]]*#' | grep . | LC_ALL=C sort; }

generated=$("$@")
status=$?
if [ "$status" -ne 0 ]; then
	[ -n "$generated" ] && printf '%s\n' "$generated" >&2
	exit "$status"
fi
current=$(printf '%s\n' "$generated" | entries)

if [ "$write_baseline" -eq 1 ]; then
	header=""
	[ -f "$baseline" ] && header=$(sed -n '/^[[:space:]]*#/!q; p' "$baseline")
	{
		[ -n "$header" ] && printf '%s\n' "$header"
		printf '%s\n' "$current" | grep .
	} >"$baseline.tmp"
	mv "$baseline.tmp" "$baseline"
	echo "wrote $baseline ($(printf '%s\n' "$current" | grep -c .) entries)"
	exit 0
fi

if [ ! -f "$baseline" ]; then
	echo "FAIL: $baseline missing. Seed it with the current output:" >&2
	[ -n "$seed_cmd" ] && echo "  $seed_cmd" >&2
	exit 1
fi

frozen=$(entries <"$baseline")
new=$(comm -23 <(printf '%s\n' "$current" | grep .) <(printf '%s\n' "$frozen" | grep .))
stale=$(comm -13 <(printf '%s\n' "$current" | grep .) <(printf '%s\n' "$frozen" | grep .))

fail=0
if [ -n "$new" ]; then
	say "$(render "$new_header" "$(printf '%s\n' "$new" | grep -c .)")"
	say ""
	say "$new"
	say ""
	say "$(render "$new_advice")"
	fail=1
fi
if [ -n "$stale" ]; then
	say "$(render "$stale_header" "$(printf '%s\n' "$stale" | grep -c .)")"
	say ""
	say "$stale"
	say ""
	say "$(render "$stale_advice")"
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

echo "ok:   $ok_text ($(printf '%s\n' "$frozen" | grep -c .) baseline entries remain)"
