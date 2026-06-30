#!/usr/bin/env bash
# Enforce the Operation error taxonomy (ADR-0036) at the thrown (in-app) seam.
# Two checks, both scoped to apps/api/convex/ source (excludes _generated and
# tests). Run as part of `bun run lint`, sibling to check-env.sh.
#
#   1. `new ConvexError(...)` may appear ONLY in _utils/errors.ts. Every
#      user-facing failure goes through the throw* helpers there, which emit the
#      canonical { category, message, data? } payload — not a hand-rolled code.
#   2. No bare `throw new Error(...)` lexically inside a user-facing
#      query/mutation/action handler block. Those failures are surfaced to the
#      frontend and must carry a category (use the throw* helpers). Internal
#      helpers and internal{Query,Mutation,Action} may still throw bare Error —
#      those are invariant bugs, never surfaced.
#
# Category-literal validity is enforced by the compiler: every error category
# usage is typed `OperationErrorCategory` (throwers, errorResponse, the SDK
# parse), so tsc rejects an out-of-union value. A bash grep can't tell an error
# `category:` from the many domain `category:` fields (ticket / complaint /
# spam …), so it is not attempted here.
#
# This is the locality guarantee made permanent — what stops re-drift back to
# 317 bare throws and a fourth code vocabulary.

set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# ── Check 1: new ConvexError only in _utils/errors.ts ────────────────────────
convex_error_hits=$(grep -rn "new ConvexError" convex --include="*.ts" 2>/dev/null \
	| grep -v "/_generated/" \
	| grep -v "/__tests__/" \
	| grep -v "\.test\.ts:" \
	| grep -v "convex/_utils/errors\.ts:" \
	|| true)

if [[ -n "$convex_error_hits" ]]; then
	echo "ERROR: 'new ConvexError(...)' outside convex/_utils/errors.ts:"
	echo ""
	echo "$convex_error_hits"
	echo ""
	echo "Throw via the coded helpers (throwNotFound / throwForbidden / throwInvalidState"
	echo "/ throwConflict / throwRateLimited / throwInternal / …) from _utils/errors.ts."
	echo ""
	fail=1
fi

# ── Check 2: bare `throw new Error` inside user-facing handler blocks ─────────
# awk walks each file tracking brace depth from the start of an
# `export const X = (query|mutation|action)({ ... })` declaration to its close,
# and flags any bare `throw new Error(` lexically within. internal* and plain
# helpers are not matched, so their bare throws are allowed.
bare_throws=$(find convex -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	! -name "*.test.ts" \
	-exec awk '
		{
			line = $0
			if (line ~ /^export const [A-Za-z0-9_]+ = (query|mutation|action)\(/) {
				inpub = 1
				depth = 0
			}
			if (inpub) {
				o = line; nopen = gsub(/{/, "", o)
				c = line; nclose = gsub(/}/, "", c)
				depth += nopen - nclose
				if (line ~ /throw[ \t]+new[ \t]+Error\(/) {
					print FILENAME ":" FNR ":" line
				}
				if ((nopen + nclose) > 0 && depth <= 0) {
					inpub = 0
				}
			}
		}
	' {} \; 2>/dev/null || true)

if [[ -n "$bare_throws" ]]; then
	echo "ERROR: bare 'throw new Error(...)' inside user-facing query/mutation/action handlers:"
	echo ""
	echo "$bare_throws"
	echo ""
	echo "Surface the failure with a coded helper from _utils/errors.ts so the frontend"
	echo "can categorize it. Internal helpers / internal* functions may keep bare Error."
	echo ""
	fail=1
fi

if [[ "$fail" -ne 0 ]]; then
	echo "Operation error taxonomy check failed. See docs/adr/0036-operation-error-taxonomy.md."
	exit 1
fi

echo "ok:   operation error taxonomy (no stray ConvexError, valid categories, no bare public throws)"
