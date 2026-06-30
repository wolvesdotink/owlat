#!/usr/bin/env bash
#
# File-size ratchet. CONVENTIONS.md documents a "split only above ~500 LOC"
# guideline (apps/api/convex/CONVENTIONS.md → "Split only above ~500 LOC") but
# nothing enforced it, so god-files accreted silently (sendLifecycle.ts 1312,
# processingLifecycle.ts 1013, team.vue 943, audit.vue 922, ...). This is the
# size sibling of scripts/check-dead-code.sh and apps/api/scripts/
# check-query-authz.sh: it counts the LOC of every source file under apps/** and
# packages/** and compares the over-cap set against a frozen baseline
# (scripts/file-size-baseline.txt).
#
# The cap is a guideline, not a hard rule, so the EXISTING oversized files are
# grandfathered in the baseline (the gate is GREEN today). The ratchet is strict
# in BOTH directions, exactly like the dead-code / query-authz gates:
#   * a file that crosses the cap and is NOT in the baseline FAILS (a new
#     god-file — split it, don't add a baseline line), and
#   * a baseline entry that has since dropped back under the cap (or was
#     deleted/renamed) FAILS — remove the line so the debt count only goes down.
#
# Baseline line format: just the repo-relative file path (no LOC count, so an
# edit that keeps the file over cap does not churn the baseline). One path per
# line, sorted.

set -uo pipefail
cd "$(dirname "$0")/.."

baseline_file="scripts/file-size-baseline.txt"
cap=500

# Collect source files under apps/** and packages/** (.ts + .vue), excluding
# generated code, build output, deps, tests and fixtures. -prune keeps find from
# descending into the heavy excluded trees at all.
current=$(find apps packages \
		\( \
			-path '*/node_modules' -o \
			-path '*/_generated' -o \
			-path '*/dist' -o \
			-path '*/.nuxt' -o \
			-path '*/.output' -o \
			-path '*/__tests__' -o \
			-path '*/fixtures' -o \
			-path '*/__fixtures__' \
		\) -prune -o \
		-type f \( -name '*.ts' -o -name '*.vue' \) \
		-not -name '*.test.ts' \
		-not -name '*.spec.ts' \
		-not -name '*.d.ts' \
		-not -iname '*fixture*' \
		-print 2>/dev/null \
	| while read -r f; do
			lines=$(wc -l <"$f" 2>/dev/null | tr -d ' ')
			[ -n "$lines" ] && [ "$lines" -gt "$cap" ] && printf '%s\n' "$f"
		done \
	| sort)

# --write-baseline: (re)seed the frozen baseline with the current over-cap set.
if [ "${1:-}" = "--write-baseline" ]; then
	printf '%s\n' "$current" | grep . >"$baseline_file" || true
	count=$(grep -c . "$baseline_file" || true)
	echo "wrote $baseline_file ($count entries)"
	exit 0
fi

if [ ! -f "$baseline_file" ]; then
	echo "FAIL: $baseline_file missing. Seed it with the current output:" >&2
	echo "  bash scripts/check-file-size.sh --write-baseline" >&2
	exit 1
fi

new=$(comm -23 <(printf '%s\n' "$current" | grep . || true) <(sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$current" | grep . || true) <(sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count file(s) over ~$cap LOC and not in $baseline_file:"
	echo ""
	echo "$new"
	echo ""
	echo "CONVENTIONS.md asks to split a feature file once it grows past ~$cap LOC"
	echo "into domain siblings (queries / mutations / actions). Split the file —"
	echo "do NOT add a new line to $baseline_file; it is frozen debt."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $baseline_file (now under cap or removed):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines so the ratchet only moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

baseline_count=$(grep -c . "$baseline_file" || true)
echo "ok:   no new files over ~$cap LOC ($baseline_count baseline entries remain)"
