#!/usr/bin/env bash
#
# Session-threading ratchet. The org-scoped builders in
# convex/lib/authedFunctions.ts (`authedQuery`, `authedMutation`, `adminQuery`,
# `adminMutation`, `ownerMutation`, plus the `featureGated` chat*/assistant*
# compositions) each resolve the caller's membership session in their auth FLOOR
# and thread it to the handler as a third argument:
#
#     export const rename = authedMutation({
#       args: { … },
#       handler: async (ctx, args, session) => { … },   // session.userId / .role
#     });                                              //   / .activeOrganizationId
#
# A handler that still calls `getMutationContext` / `getUserIdFromSession` /
# `getBetterAuthSession(WithRole)` / `requireOrgMember` / `requireOrgPermission` /
# `requireAdminContext` / `requireOwnerContext` therefore resolves the SAME
# session a second time — an extra `ctx.db` round trip per call and a second,
# drift-prone copy of the auth decision. Role checks belong on the threaded
# session instead: `requirePermission(hasPermission(session.role, '<scope>:<verb>'))`
# (which check-query-authz.sh and check-permissions.sh both accept as a gate).
#
# ~300 handlers predate the threading, so this is a RATCHET, not a baseline-0
# hard gate. scripts/ratchet.sh runs the comparison, strict in BOTH directions,
# exactly like check-query-authz.sh and scripts/check-file-size.sh:
#   * a re-resolving handler that is NOT in scripts/session-threading-baseline.txt
#     FAILS (new code copying the old pattern — take the threaded session), and
#   * a baseline entry that no longer re-resolves (converted, renamed, deleted)
#     FAILS as stale — delete the line so the debt count only goes down.
#
# A site passes when it does ONE of:
#   * takes the threaded session instead of re-resolving;
#   * carries an explicit opt-out comment — inside the handler body, or on the
#     line directly above the `export const`:
#       // session: <why this handler must resolve a session of its own>
#   * is listed in the baseline (frozen debt).
#
# HEURISTIC LIMITS (this is grep/awk pragmatism, not a parser — same tradeoff as
# check-query-authz.sh):
#   * Granularity is per registered function (`file:exportName`), delimited by
#     `^export const <name> = <builder>(` … `^})` at column 0. This is what makes
#     the gate precise about the common ambiguity: 63 of the 104 debt files ALSO
#     export a non-threading function (`internalQuery`/`internalMutation`/
#     `internalAction`, `publicQuery`/`publicMutation`, `authedAction`,
#     `authedIdentityMutation`), where resolving a session by hand is CORRECT —
#     e.g. the documented "soft-failing read stays on publicQuery with an
#     in-handler membership check" pattern. Those blocks are never entered, so
#     they are never flagged; a file-level gate would have called all 63 of them
#     violations.
#   * A handler that delegates to a module-scope shared guard which re-resolves
#     (convex/contacts/guards.ts, convex/campaigns/guards.ts,
#     convex/mail/permissions.ts, …) is NOT flagged — the helper call is outside
#     any registered-function block. ~18 such call sites exist; converting them
#     means changing the guard's signature to accept a session, which the ratchet
#     deliberately does not force.
#   * Only the first re-resolution per handler is reported (one baseline line per
#     handler, so fixing one of two calls does not churn the baseline).
#   * A `^})` at column 0 inside a handler body would end the block early. No
#     such formatting exists today (oxfmt keeps nested closers indented) and the
#     block scanner reports nothing unterminated across the tree.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

builders='authedQuery|authedMutation|adminQuery|adminMutation|ownerMutation|chatQuery|chatMutation|assistantQuery|assistantMutation'
helpers='getMutationContext|getUserIdFromSession|getBetterAuthSessionWithRole|getBetterAuthSession|requireOrgMember|requireOrgPermission|requireAdminContext|requireOwnerContext'

generate() {
	find convex -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		-not -path "convex/lib/*" \
		-exec awk -v builders="$builders" -v helpers="$helpers" '
			BEGIN { in_fn = 0; name = ""; hit = 0; block_optout = 0 }
			{
				is_comment = ($0 ~ /^[[:space:]]*\/\//)
				is_optout  = ($0 ~ /\/\/[[:space:]]*session:/)
				is_export  = ($0 ~ "^export const [A-Za-z0-9_]+ = (" builders ")\\(")
			}
			is_comment && is_optout { block_optout = 1 }
			is_export {
				in_fn = 1; name = $3
				hit = 0
				optout = block_optout
				block_optout = 0
				next
			}
			in_fn && is_optout { optout = 1 }
			in_fn && $0 ~ "(^|[^A-Za-z0-9_.])(" helpers ")\\(" { hit = 1 }
			in_fn && /^\}\)/ {
				if (hit && !optout) print FILENAME ":" name
				in_fn = 0
			}
			(!is_comment && !is_export) { block_optout = 0 }
		' {} \; 2>/dev/null | LC_ALL=C sort -u
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/session-threading-baseline.txt \
	--seed "bash apps/api/scripts/check-session-threading.sh --write-baseline" \
	--ok "no new handler re-resolves its floor's session" \
	--new-header "FAIL: {n} handler(s) re-resolve the session their auth floor already resolved:" \
	--new-advice "Use the threaded session: the org-scoped builders pass the floor's
resolved session to the handler as its third argument —
  handler: async (ctx, args, session) => { … }
with session.userId / session.role / session.activeOrganizationId. For a
role gate call requirePermission(hasPermission(session.role, '<scope>:<verb>'))
instead of requireOrgPermission/requireAdminContext(ctx).
If a handler genuinely needs its own session resolution, add a
'// session: <reason>' comment. Do NOT add new entries to {baseline} —
it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (handler converted, renamed or removed):" \
	"$@" \
	-- bash "$self" --generate
