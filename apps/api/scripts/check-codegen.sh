#!/usr/bin/env bash
#
# Guard against stale committed Convex codegen.
#
# Verifies that _generated/api.d.ts references every Convex module, so a new
# query/mutation/action/file can't ship with stale generated types because
# `convex codegen` was never re-run (which is how lib/mailHost + lib/scannerHealth
# previously drifted). The full `convex codegen` needs a live deployment; this
# static check needs nothing and catches the common module-list drift in CI.
#
set -euo pipefail
cd "$(dirname "$0")/.." # apps/api

GEN="convex/_generated/api.d.ts"

# Special files Convex codegen intentionally omits from the module registry
# (the schema, the instance auth config, and Convex-component definitions,
# incl. the betterAuth component).
EXCLUDE_RE='^convex/(schema|auth\.config|convex\.config|plugins/(plugins|components)\.generated|betterAuth/(schema|convex\.config|adapter))\.ts$'

missing=0
while IFS= read -r file; do
	if [[ "$file" =~ $EXCLUDE_RE ]]; then continue; fi
	key="${file#convex/}"
	key="${key%.ts}"
	if ! grep -q "from \"../$key.js\"" "$GEN"; then
		echo "  missing from _generated/api.d.ts: $key"
		missing=$((missing + 1))
	fi
done < <(find convex -name '*.ts' \
	-not -path 'convex/_generated/*' \
	-not -path 'convex/betterAuth/_generated/*' \
	-not -name '*.d.ts' \
	-not -name '*.test.ts' \
	-not -path '*/__tests__/*' | sort)

if [ "$missing" -gt 0 ]; then
	echo "FAIL: $missing Convex module(s) absent from _generated/api.d.ts."
	echo "      Run 'npx convex codegen' in apps/api and commit the result."
	exit 1
fi

echo "ok:   _generated/api.d.ts references every Convex module"
