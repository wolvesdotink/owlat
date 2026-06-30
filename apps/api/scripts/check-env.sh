#!/usr/bin/env bash
# Enforce: all process.env.* reads in apps/api/convex/ must go through lib/env.ts.
# This is the lint rule that oxlint can't express directly (no-restricted-syntax
# is not supported). Run as part of `bun run lint`.

set -euo pipefail

cd "$(dirname "$0")/.."

# grep returns exit 1 when no matches; we want failure only when matches exist.
matches=$(grep -rn "process\.env\." convex --include="*.ts" 2>/dev/null \
	| grep -v "^convex/lib/env\.ts:" \
	| grep -v "/__tests__/" \
	| grep -v "\.test\.ts:" \
	| grep -v "\.spec\.ts:" \
	|| true)

if [[ -n "$matches" ]]; then
	echo "ERROR: process.env.* read outside convex/lib/env.ts:"
	echo ""
	echo "$matches"
	echo ""
	echo "Use getRequired/getOptional/getWithDefault from convex/lib/env.ts."
	echo "Add new keys to the EnvKey union there."
	exit 1
fi
