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
# grandfathered in the baseline (the gate is GREEN today). scripts/ratchet.sh
# runs the comparison — strict in BOTH directions, like every other baseline
# here: a file that crosses the cap and is not listed fails (split it, don't add
# a line), and a listed file that dropped back under the cap fails as stale.
#
# Baseline line format: just the repo-relative file path (no LOC count, so an
# edit that keeps the file over cap does not churn the baseline). One path per
# line, sorted.

set -uo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

cap=500

# Collect source files under apps/** and packages/** (.ts + .vue), excluding
# generated code, build output, deps, tests and fixtures. -prune keeps find from
# descending into the heavy excluded trees at all.
generate() {
	find apps packages \
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
		done
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec scripts/ratchet.sh \
	--baseline scripts/file-size-baseline.txt \
	--seed "bash scripts/check-file-size.sh --write-baseline" \
	--ok "no new files over ~$cap LOC" \
	--new-header "FAIL: {n} file(s) over ~$cap LOC and not in {baseline}:" \
	--new-advice "CONVENTIONS.md asks to split a feature file once it grows past ~$cap LOC
into domain siblings (queries / mutations / actions). Split the file —
do NOT add a new line to {baseline}; it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (now under cap or removed):" \
	"$@" \
	-- bash "$self" --generate
