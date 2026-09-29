#!/usr/bin/env bash
# Requires every public **state-changing** Convex function to make an explicit
# authorization decision.
#
# `authedMutation` / `authedAction` only enforce the *floor* — an authenticated
# org member (any role, including `editor`). That floor alone is not an
# authorization decision: a write that should be admin-only but forgets its
# `requirePermission(...)` check silently lets any member perform it. Unlike the
# secure-by-default *authentication* rule (check-public-functions.sh), the
# *authorization* check has historically been a hand-written convention with no
# CI gate — this script closes that gap.
#
# The scanned builders are every mutation/action builder with a MEMBER floor,
# derived from source by scripts/lib/convex-builders.sh: `authedMutation`,
# `authedAction` and every `featureGated(Any)` composition of them
# (`chatMutation`, `assistantMutation`, `postboxMutation`, and the next one
# someone composes). A feature flag is NOT an authorization decision, so a
# composition stays SUBJECT to this gate: each chat / assistant / postbox write
# must still make its own in-handler authz decision (assertCanWriteRoom /
# conversation-owner check / requireMailboxAccess / requireOrgPermission).
#
# A site passes when it does ONE of:
#
#   * uses a role-bearing wrapper instead — `adminMutation` / `ownerMutation`
#     (role floor, so the gate lives in the wrapper and they are not scanned);
#   * calls a recognized authorization gate inside the handler — the shared
#     CONVEX_AUTHZ_GATES list in scripts/lib/convex-builders.sh
#     (requirePermission / requireOrgPermission / requireMailboxAccess /
#     assertCanWriteRoom / requirePlatformAdmin / …);
#   * carries an explicit opt-out comment — either inside the handler body, or on
#     the line directly above the `export const`:
#       // authz: <why this needs no role check / where the gate actually lives>
#       // all-members: <why every org member may legitimately do this>
#
# Like check-public-functions.sh this is a HARD gate (baseline 0): a forgotten
# authorization check is a privilege-escalation bug, not style drift, so it must
# fail CI outright. When you add a new gate helper, add its name to
# CONVEX_AUTHZ_GATES.

set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/convex-builders.sh
. scripts/lib/convex-builders.sh

builders=$(convex_builder_regex 'mutation|action' 'member') || exit 1

# The span scanner (scripts/lib/convex-defs.awk) opens a span on each
# `export const X = <builder>(` and closes it on the column-0 `})`; this
# fragment reports a span with neither a gate token nor an opt-out comment.
program=$(convex_defs_program '
	function on_start() { gate = 0 }
	function on_line() { if ($0 ~ gates) gate = 1 }
	function on_end() { if (!gate && !def_optout) print FILENAME ":" def_start ":" def_name }
') || exit 1

violations=$(find convex -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	-print0 | xargs -0 -r awk -v builders="$builders" -v optout='authz|all-members' \
		-v gates="($CONVEX_AUTHZ_GATES)" "$program") || {
	echo "FAIL: the definition scanner failed; see the error above."
	exit 1
}

count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count authedMutation/authedAction definition(s) with no authorization decision."
	echo ""
	echo "$violations"
	echo ""
	echo "authedMutation/authedAction only require an authenticated org member (any"
	echo "role). A state-changing public function must also decide WHO may run it:"
	echo "  - use adminMutation / ownerMutation (role baked into the wrapper), or"
	echo "  - call requirePermission(hasPermission(role, '<scope>:<verb>')) / "
	echo "    requireAdminContext / requireOrgPermission / requireMailboxAccess / etc., or"
	echo "  - add a '// authz: <reason>' (gate lives elsewhere) or"
	echo "    '// all-members: <reason>' (intentionally open to every member) comment."
	exit 1
fi

echo "ok:   every authedMutation/authedAction has an explicit authorization decision"
