#!/usr/bin/env bash
#
# File-size gate. CONVENTIONS.md documents a "split only above ~500 LOC"
# guideline (apps/api/convex/CONVENTIONS.md → "Split only above ~500 LOC");
# this enforces it. It counts the LOC of every source file under apps/** and
# packages/** and fails on any over the cap. It is the size sibling of
# scripts/check-dead-code.sh and apps/api/scripts/check-query-authz.sh.
#
# There is no baseline: scripts/ratchet.sh --zero fails on every file the
# generator reports, so a file that grows past the cap is split into domain
# siblings, never excused.

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
	--zero \
	--ok "no files over ~$cap LOC" \
	--new-header "FAIL: {n} file(s) over ~$cap LOC:" \
	--new-advice "CONVENTIONS.md asks to split a feature file once it grows past ~$cap LOC
into domain siblings (queries / mutations / actions, or a page's sections
as child components and composables)." \
	"$@" \
	-- bash "$self" --generate
