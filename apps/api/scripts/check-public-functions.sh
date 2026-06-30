#!/usr/bin/env bash
# Bans the bare `query(` / `mutation(` / `action(` Convex builders everywhere
# in apps/api/convex/ except the wrapper module that defines the safe ones.
#
# Convex publishes every non-`internal` function on the public client API, so a
# bare builder is an unauthenticated endpoint unless the handler remembers to
# gate itself. To make the safe path the default, public functions must use the
# secure-by-default builders from `convex/lib/authedFunctions.ts`:
#
#   authedQuery / authedMutation / authedAction   — require auth (the default)
#   authedIdentityMutation                        — auth identity, pre-org (signup)
#   publicQuery / publicMutation / publicAction   — explicit, intentional opt-out
#                                                   (token links, webhooks,
#                                                   tracking pixels, setup page);
#                                                   must carry a `// public:` note
#
# `internalQuery` / `internalMutation` / `internalAction` and `httpAction`
# are unaffected (server-only, or a separately-authenticated HTTP surface).
#
# This is a hard gate (baseline 0), unlike the ratcheted counts in
# check-convex-patterns.sh — a forgotten auth gate is a security bug, not a
# style drift, so it must fail CI outright.

cd "$(dirname "$0")/.."

# Three shapes of "assign the bare builder to a name", all anchored on `=` so
# they cannot match prose ("... the query (foo) ...") and so the prefixed
# builders — `= authedQuery(` / `= internalQuery(` / `= publicQuery(` /
# `= httpAction(` — never match (there are characters between `=` and the bare
# name). `ctx.db.query(` has no `=` and is likewise ignored.
#
#   1. call site (same line):   const foo = query({ … })
#   2. alias (same line):       export const publicQuery = query;   (no `(`)
#   3. definition (next line):  const foo =
#                                 query({ … })
#
# 1+2 are caught by one extended-regexp grep; 3 needs a two-line awk pass
# because the builder lands on the line *after* the `=`. awk (not `grep -Pz`)
# keeps it portable — GNU grep on CI and BSD/ugrep locally disagree on `-P`/`-z`.
PATTERN='=[[:space:]]*(query|mutation|action)[[:space:]]*(\(|[;,]?[[:space:]]*$)'

filter() {
	grep -v "/_generated/" | grep -v "/__tests__/" | grep -v "convex/lib/authedFunctions.ts"
}

single_line=$(grep -rnE "$PATTERN" convex --include="*.ts" 2>/dev/null | filter || true)

# Multi-line: a line ending in `=` immediately followed by a line whose first
# token is exactly the bare `query` / `mutation` / `action` builder. The leading
# `^[[:space:]]*` anchor is what excludes `authedQuery(` / `internalAction(` —
# those don't *start* with the bare name.
multi_line=$(find convex -name "*.ts" -type f 2>/dev/null | filter | while IFS= read -r f; do
	awk '
		prev_eq && $0 ~ /^[[:space:]]*(query|mutation|action)[[:space:]]*\(/ {
			printf "%s:%d:%s\n", FILENAME, FNR, $0
		}
		{ prev_eq = ($0 ~ /=[[:space:]]*$/) }
	' "$f"
done)

violations=$(printf '%s\n%s\n' "$single_line" "$multi_line" | grep . || true)

count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count bare query()/mutation()/action() builder reference(s) found."
	echo ""
	echo "$violations"
	echo ""
	echo "Public Convex functions are reachable by anonymous internet callers."
	echo "Use the secure-by-default builders from convex/lib/authedFunctions.ts:"
	echo "  - authedQuery / authedMutation / authedAction  (require auth)"
	echo "  - publicQuery / publicMutation / publicAction   (intentional, '// public:' note)"
	echo "  - internalQuery / internalMutation / internalAction  (server-only)"
	exit 1
fi

echo "ok:   no bare query()/mutation()/action() builders outside lib/authedFunctions.ts"
