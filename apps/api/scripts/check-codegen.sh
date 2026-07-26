#!/usr/bin/env bash
#
# Guard against stale committed Convex codegen.
#
# Verifies that _generated/api.d.ts imports and maps every Convex module, so a new
# query/mutation/action/file can't ship with stale generated types because
# `convex codegen` was never re-run (which is how lib/mailHost + lib/scannerHealth
# previously drifted). The full `convex codegen` needs a live deployment; this
# static check needs nothing and catches the common module-list drift in CI.
#
set -euo pipefail
cd "$(dirname "$0")/.." # apps/api

CONVEX_ROOT="${CODEGEN_SOURCE_DIR:-convex}"
GEN="${CODEGEN_DECLARATION_FILE:-convex/_generated/api.d.ts}"

# Special files Convex codegen intentionally omits from the module registry
# (the schema, the instance auth config, and Convex-component definitions,
# incl. the betterAuth component).
EXCLUDE_RE='^(schema|auth\.config|convex\.config|plugins/(plugins|components)\.generated|betterAuth/(schema|convex\.config|adapter))\.ts$'

missing=0
while IFS= read -r file; do
	key="${file#"$CONVEX_ROOT"/}"
	if [[ "$key" =~ $EXCLUDE_RE ]]; then continue; fi
	key="${key%.ts}"
	import_line="$(
		grep -F "../$key.js" "$GEN" |
			grep -E '^import type \* as [A-Za-z0-9_]+ from ' || true
	)"
	if [[ -z "$import_line" ]]; then
		echo "  missing import from _generated/api.d.ts: $key"
		missing=$((missing + 1))
		continue
	fi
	module_alias="${import_line#import type * as }"
	module_alias="${module_alias%% from *}"
	if ! grep -Fq "'$key': typeof $module_alias;" "$GEN" &&
		! grep -Fq "\"$key\": typeof $module_alias;" "$GEN" &&
		! grep -Fq "$key: typeof $module_alias;" "$GEN"; then
		echo "  missing fullApi mapping from _generated/api.d.ts: $key"
		missing=$((missing + 1))
	fi
done < <(find "$CONVEX_ROOT" -name '*.ts' \
	-not -path "$CONVEX_ROOT/_generated/*" \
	-not -path "$CONVEX_ROOT/betterAuth/_generated/*" \
	-not -name '*.d.ts' \
	-not -name '*.test.ts' \
	-not -path '*/__tests__/*' | sort)

if [ "$missing" -gt 0 ]; then
	echo "FAIL: $missing Convex module import/mapping(s) absent from _generated/api.d.ts."
	echo "      Run 'npx convex codegen' in apps/api and commit the result."
	exit 1
fi

echo "ok:   _generated/api.d.ts imports and maps every Convex module"
