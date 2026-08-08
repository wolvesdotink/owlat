#!/usr/bin/env bash
# Enforce: all process.env reads in apps/api/convex/ must go through lib/env.ts.
# This is the lint rule that oxlint can't express directly (no-restricted-syntax
# is not supported). Run as part of `bun run lint`.
#
# EVERY access form counts, so the pattern is the bare object: `process.env.FOO`,
# `process.env['FOO']`, `process.env?.FOO`, `const { FOO } = process.env` and
# `Object.entries(process.env)` are all the same read, and each one bypasses the
# EnvKey union — the bracket and destructuring forms are exactly the shapes a key
# computed at runtime takes, the case the union exists to prevent. Naming the
# access syntax at all would leave the next form to be discovered by an incident.
#
# Optional first arg overrides the scan root (default `convex`) so the self-test
# can point it at a fixture tree.

set -euo pipefail

cd "$(dirname "$0")/.."

root="${1:-convex}"

# grep returns exit 1 when no matches; we want failure only when matches exist.
matches=$(grep -rnE "process\.env" "$root" --include="*.ts" 2>/dev/null \
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
