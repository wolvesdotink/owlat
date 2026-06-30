#!/usr/bin/env bash
#
# Canonical-org guard. The public home is `wolvesdotink/owlat`
# (github.com/wolvesdotink/owlat, ghcr.io/wolvesdotink/*). The repo previously
# carried a placeholder `owlat/owlat` / `ghcr.io/owlat` org across the runtime
# update checker, desktop updater, Dockerfiles, provisioning templates, and
# their tests — a split that survived ~20 review passes precisely because some
# tests *asserted* the stale org, so green CI certified the wrong branding.
#
# This is a sibling of check-adr-numbers.sh / check-dead-code.sh: a hard-0
# invariant (no baseline). It scans every tracked file for the forbidden org
# slugs and fails on any hit, so the canonical org cannot silently regress.
#
# The three negative-assertion guard tests below legitimately embed the pattern
# as a regex literal (they assert its *absence* elsewhere), so they are the only
# allowed exceptions — listed explicitly rather than excluding all tests, so a
# NEW test that hardcodes the stale org is still caught.

set -uo pipefail
cd "$(dirname "$0")/.."

# Forbidden patterns (extended regex): the placeholder GitHub org + GHCR registry.
forbidden='(github\.com[:/]owlat/owlat|api\.github\.com/repos/owlat/owlat|ghcr\.io/owlat/|"owlat/owlat"|github\.com/wolves(-labs)?/owlat)'

# Files allowed to contain the pattern (negative-assertion guards + this script).
allow_re='^(scripts/check-branding\.sh|apps/setup-cli/src/lib/__tests__/installerEntrypoints\.guards\.test\.ts|apps/docs/__tests__/selfHostingDocs\.test\.ts|packages/shared/src/__tests__/composeHardening\.test\.ts)$'

hits=""
while IFS= read -r f; do
	[ -f "$f" ] || continue
	if printf '%s\n' "$f" | grep -qE "$allow_re"; then continue; fi
	if grep -IlE "$forbidden" "$f" >/dev/null 2>&1; then
		hits="$hits$f"$'\n'
	fi
done < <(git ls-files)

if [ -n "$hits" ]; then
	count=$(printf '%s' "$hits" | grep -c .)
	echo "FAIL: $count file(s) reference the stale org (use wolvesdotink/owlat + ghcr.io/wolvesdotink):"
	echo ""
	printf '%s' "$hits" | sed 's/^/  /'
	echo ""
	printf '%s' "$hits" | while IFS= read -r f; do
		[ -n "$f" ] || continue
		grep -nIE "$forbidden" "$f" | sed "s#^#    $f:#"
	done
	exit 1
fi

echo "ok:   no stale-org (owlat/owlat, ghcr.io/owlat, wolves/owlat) references"
