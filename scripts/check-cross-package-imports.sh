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

# import/export … from '…', bare import '…', dynamic import('…'), require('…')
# whose specifier climbs out of the package into packages/ or apps/.
forbidden="(from[[:space:]]+|import[[:space:]]*\(?[[:space:]]*|require[[:space:]]*\([[:space:]]*)['\"](\.\./)+((packages|apps)/)"

hits=""
while IFS= read -r f; do
	[ -f "$f" ] || continue
	case "$f" in
		*/_generated/*) continue ;;
		scripts/check-cross-package-imports.sh) continue ;;
	esac
	if grep -qIE "$forbidden" "$f" 2>/dev/null; then
		hits="$hits$f"$'\n'
	fi
done < <(git ls-files -- '*.ts' '*.tsx' '*.vue' '*.js' '*.mjs' '*.cjs')

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
while IFS= read -r m; do
	case "$m" in
		packages/mta-protocol/package.json) continue ;;
	esac
	if node -e 'const m = require("./" + process.argv[1]); const deps = { ...m.dependencies, ...m.devDependencies, ...m.peerDependencies }; process.exit("@owlat/mta-protocol" in deps ? 1 : 0)' "$m"; then
		:
	else
		cycle="$cycle$m declares a dependency on @owlat/mta-protocol"$'\n'
	fi
done < <(git ls-files -- 'packages/*/package.json')

while IFS= read -r f; do
	[ -f "$f" ] || continue
	case "$f" in
		packages/mta-protocol/*) continue ;;
	esac
	if grep -qIE "['\"]@owlat/mta-protocol(/|['\"])" "$f" 2>/dev/null; then
		cycle="$cycle$f imports @owlat/mta-protocol"$'\n'
	fi
done < <(git ls-files -- 'packages/*.ts' 'packages/*.tsx' 'packages/*.vue' 'packages/*.js' 'packages/*.mjs' 'packages/*.cjs')

if [ -n "$cycle" ]; then
	echo ""
	echo "FAIL: packages/ must never depend on @owlat/mta-protocol (D7's one-way edge)."
	echo "The wire package is a leaf: apps import it, packages/ does not."
	echo ""
	printf '%s' "$cycle" | sed 's#^#  #'
	exit 1
fi

echo "ok:   no packages/ workspace depends on @owlat/mta-protocol (D7 one-way edge)"
