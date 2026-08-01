#!/usr/bin/env bash
# Enforce: all process.env reads in apps/api/convex/ must go through lib/env.ts.
# This is the lint rule that oxlint can't express directly (no-restricted-syntax
# is not supported). Run as part of `bun run lint`.
#
# BOTH access forms count. `process.env.FOO` and `process.env['FOO']` are the
# same read, and a rule that only saw the dotted one would let the bracket form
# bypass the EnvKey union — which is exactly the shape a key computed at runtime
# takes, the case the union exists to prevent.
#
# Optional first arg overrides the scan root (default `convex`) so the self-test
# can point it at a fixture tree.

set -euo pipefail

cd "$(dirname "$0")/.."

root="${1:-convex}"

# Alternation, not a bracket expression: `[.\[]` means different things to GNU
# and BSD grep (a literal backslash is in the set for one of them).
#
# grep returns exit 1 when no matches; we want failure only when matches exist.
matches=$(grep -rnE "process\.env(\.|\[)" "$root" --include="*.ts" 2>/dev/null \
	| grep -v "^${root}/lib/env\.ts:" \
	| grep -v "/__tests__/" \
	| grep -v "\.test\.ts:" \
	| grep -v "\.spec\.ts:" \
	|| true)

if [[ -n "$matches" ]]; then
	echo "ERROR: process.env read outside convex/lib/env.ts:"
	echo ""
	echo "$matches"
	echo ""
	echo "Use getRequired/getOptional/getWithDefault from convex/lib/env.ts."
	echo "Add new keys to the EnvKey union there."
	exit 1
fi
