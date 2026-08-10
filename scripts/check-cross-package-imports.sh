#!/usr/bin/env bash
#
# Cross-package import guard. Workspace packages are imported by name
# (`@owlat/ui/composables/useRichText`, `@owlat/shared`, `@owlat/api/dataModel`)
# — never by climbing out of the package with a relative path
# (`../../../../packages/ui/composables/useRichText`). The deep-relative form
# bypasses each package's public surface, breaks when files move, and reads as
# noise; it survived only in test files until the 2026-07-06 dedupe sweep.
#
# This is a sibling of check-branding.sh: a hard-0 invariant (no baseline). It
# scans every tracked source file for import/export/require specifiers whose
# path climbs into `packages/` or `apps/` and fails on any hit.
#
# Not matched (deliberately): Nuxt layer `extends: ['../../packages/ui']`,
# vitest alias `resolve(__dirname, '../../packages/…')`, and shell `cd` paths —
# those are build wiring, not module imports.

set -uo pipefail
cd "$(dirname "$0")/.."

# ONE GREP PER SCAN, NOT ONE PER FILE. Each of the four scans below asks the
# same question of thousands of tracked files (4706 for the two repo-wide ones),
# and a `while read; do grep "$f"; done` loop pays a fork per file for it — ~5700
# processes and the better part of ten seconds on every `bun run lint` and every
# CI job, to read a few megabytes. `git ls-files -z | xargs -0 grep -lIE` asks it
# once per batch instead and finishes in hundredths of a second.
#
# The shape is the same in all four: list the candidate paths, let ONE grep
# reduce them to the files that match, then drop the exempt paths FROM THE
# MATCHES. Filtering after the grep rather than before it is what keeps the
# exemption list cheap — it runs over the handful of hits, not over the tree —
# and it is why the exclusions below are written as path patterns rather than as
# `case` arms.
#
# `-r` so an empty candidate list runs no grep at all (bare `grep -l` with no
# file operand would read stdin and hang); `|| true` because grep exits 1 when a
# batch has no match and xargs turns that into 123, neither of which is an error
# here — an empty result is the state this gate exists to keep.
#
# `[ -f "$f" ]` is gone with the loop: a tracked file deleted in the working tree
# makes grep complain on stderr (discarded) and match nothing, which is the same
# verdict the guard produced.
scan() {
	local pattern="$1"
	shift
	git ls-files -z -- "$@" | xargs -0 -r grep -lIE "$pattern" 2>/dev/null || true
}

# import/export … from '…', bare import '…', dynamic import('…'), require('…')
# whose specifier climbs out of the package into packages/ or apps/.
forbidden="(from[[:space:]]+|import[[:space:]]*\(?[[:space:]]*|require[[:space:]]*\([[:space:]]*)['\"](\.\./)+((packages|apps)/)"

SOURCES=('*.ts' '*.tsx' '*.vue' '*.js' '*.mjs' '*.cjs')

hits=$(scan "$forbidden" "${SOURCES[@]}" |
	grep -v -e '/_generated/' -e '^scripts/check-cross-package-imports\.sh$' || true)
[ -n "$hits" ] && hits="$hits"$'\n'

if [ -n "$hits" ]; then
	count=$(printf '%s' "$hits" | grep -c .)
	echo "FAIL: $count file(s) import across package boundaries with relative paths."
	echo "Import workspace packages by name instead (e.g. '@owlat/ui/composables/…')."
	echo ""
	printf '%s' "$hits" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		grep -nE "$forbidden" "$f" | sed "s#^#  $f:#"
	done
	exit 1
fi

echo "ok:   no relative imports crossing package boundaries (use @owlat/* specifiers)"

# ── The one-way edge: nothing in packages/ may import @owlat/mta-protocol ──
#
# D7's wire package is a LEAF: apps import it, packages/ does not. It depends on
# `@owlat/shared` because the wire is stated in terms of the shared vocabularies
# (DeliveryDomain, GovernedRoutingContext, the destination-provider taxonomy, the
# readiness verdicts), and re-declaring any of them to buy literal
# zero-dependency status would trade one duplication for a worse one. That trade
# is only safe while the edge runs ONE WAY.
#
# The `@owlat/shared` direction would make an outright package cycle, which `bun
# install`, knip, tsc and check-build-graph.ts all accept in silence. The other
# packages would not cycle — which is worse, not better: nothing else in CI would
# notice at all, and the leaf would have quietly become a mid-graph node that
# every consumer of that package now carries. So the scan is every workspace
# package except the wire package itself.
cycle=""

# ONE node, reading every manifest, instead of one interpreter start per
# package.json. A manifest that cannot be read or parsed counts as a hit, which
# is what the per-file version did too (a `require` that threw exited non-zero
# and landed in this same list): the gate would rather name a broken manifest
# than pass one it never managed to check.
manifests=$(git ls-files -- 'packages/*/package.json' |
	grep -v '^packages/mta-protocol/package\.json$' || true)
if [ -n "$manifests" ]; then
	declared=$(printf '%s\n' "$manifests" | node -e '
		const fs = require("node:fs");
		for (const p of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
			let hit = true;
			try {
				const m = JSON.parse(fs.readFileSync(p, "utf8"));
				const deps = { ...m.dependencies, ...m.devDependencies, ...m.peerDependencies };
				hit = "@owlat/mta-protocol" in deps;
			} catch {
				hit = true;
			}
			if (hit) process.stdout.write(p + " declares a dependency on @owlat/mta-protocol\n");
		}
	')
	[ -n "$declared" ] && cycle="$cycle$declared"$'\n'
fi

imports=$(scan "['\"]@owlat/mta-protocol(/|['\"])" \
	'packages/*.ts' 'packages/*.tsx' 'packages/*.vue' 'packages/*.js' 'packages/*.mjs' 'packages/*.cjs' |
	grep -v '^packages/mta-protocol/' || true)
if [ -n "$imports" ]; then
	cycle="$cycle$(printf '%s\n' "$imports" | sed 's#$# imports @owlat/mta-protocol#')"$'\n'
fi

if [ -n "$cycle" ]; then
	echo ""
	echo "FAIL: packages/ must never depend on @owlat/mta-protocol (D7's one-way edge)."
	echo "The wire package is a leaf: apps import it, packages/ does not."
	echo ""
	printf '%s' "$cycle" | sed 's#^#  #'
	exit 1
fi

echo "ok:   no packages/ workspace depends on @owlat/mta-protocol (D7 one-way edge)"

# ── `@owlat/mta-protocol/wireFixtures` is test-only, and only this says so ──
#
# The frozen wire fixtures live in `src/` rather than a `__tests__` folder for
# one reason: it is the only place BOTH apps can import ONE copy from, and a
# fixture each suite kept its own copy of would drift with the code it exists to
# catch. The cost of that is a public subpath export — so `import { … } from
# '@owlat/mta-protocol/wireFixtures'` resolves just as happily from a shipped
# handler as from a suite, and knip treats the subpath as an entry, which exempts
# everything it exports from the dead-code ratchet. Nothing else would notice
# fixture bytes reaching production; this does.
fixtures=$(scan "['\"]@owlat/mta-protocol/wireFixtures['\"]" "${SOURCES[@]}" |
	grep -v -e '/__tests__/' -e '^scripts/check-cross-package-imports\.sh$' || true)
[ -n "$fixtures" ] && fixtures="$fixtures"$'\n'

if [ -n "$fixtures" ]; then
	count=$(printf '%s' "$fixtures" | grep -c .)
	echo ""
	echo "FAIL: $count file(s) outside a __tests__/ folder import @owlat/mta-protocol/wireFixtures."
	echo "The frozen wire fixtures are test-only; production code must import the"
	echo "wire declarations ('@owlat/mta-protocol/send', '/routingDecision', …)."
	echo ""
	printf '%s' "$fixtures" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		grep -nE "['\"]@owlat/mta-protocol/wireFixtures['\"]" "$f" | sed "s#^#  $f:#"
	done
	exit 1
fi

echo "ok:   @owlat/mta-protocol/wireFixtures imported only from __tests__/ folders"
