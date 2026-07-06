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
