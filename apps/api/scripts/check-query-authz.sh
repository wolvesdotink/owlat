#!/usr/bin/env bash
# Requires every public **read** Convex function to make an explicit
# authorization decision — the query-side sibling of check-permissions.sh.
#
# `authedQuery` only enforces the *floor* — an authenticated org member (any
# role, including `editor`). Most reads are legitimately member-visible, but a
# read that should be owner/admin-only (shared-inbox content, audit data,
# credential envelopes) and forgets its gate silently exposes that data to
# every member. check-permissions.sh deliberately covers only state-changing
# functions, so query-side authorization had NO ci gate — this script closes
# that gap (the `unifiedMessages.listRecent` escalation slipped through it).
#
# A site passes when it does ONE of:
#
#   * calls a recognized authorization gate inside the handler (same token list
#     as check-permissions.sh);
#   * carries an explicit opt-out comment — inside the handler body, or on the
#     line directly above the `export const`:
#       // authz: <why this needs no role check / where the gate actually lives>
#       // all-members: <why every org member may legitimately read this>
#   * is listed in scripts/query-authz-baseline.txt — the frozen pre-existing
#     debt (file:name pairs). Unlike the mutation gate this is a RATCHET, not a
#     baseline-0 hard gate: 160 queries predate the rule and annotating them
#     wholesale would rubber-stamp real authorization questions. New queries
#     must decide; baseline queries should lose their entry as they're reviewed.
#
# The ratchet is strict in both directions: an unlisted violation fails (new
# query without a decision), and a stale baseline entry fails (the query was
# fixed/removed — delete its line so the debt count only goes down).
#
# NOTE: `chatQuery` / `assistantQuery` (chat/_helpers.ts,
# assistant/conversations.ts) compose `authedQuery` with a `assertFeatureEnabled`
# FEATURE-flag floor only — a feature flag is NOT an authorization decision — so
# they are matched by the is_export regex below and remain SUBJECT to this
# ratchet exactly like a bare `authedQuery`. The pre-existing chat reads keep
# their baseline entries until each is individually reviewed.

cd "$(dirname "$0")/.."

baseline_file="scripts/query-authz-baseline.txt"

violations=$(find convex -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	-exec awk '
		BEGIN { in_fn = 0; gate = 0; name = ""; block_optout = 0 }
		{
			is_comment = ($0 ~ /^[[:space:]]*\/\//)
			is_optout  = ($0 ~ /\/\/[[:space:]]*(authz|all-members):/)
			is_export  = ($0 ~ /^export const [A-Za-z0-9_]+ = (authedQuery|chatQuery|assistantQuery)\(/)
		}
		is_comment && is_optout { block_optout = 1 }
		is_export {
			in_fn = 1; name = $3
			gate = block_optout
			block_optout = 0
		}
		in_fn && $0 ~ /(requirePermission|requireAdminContext|requireOwnerContext|requireOrgPermission|loadOwnedMailbox|loadOwnedMessage|assertCanReadRoom|assertCanWriteRoom|assertCanAdministerRoom|requirePlatformAdmin)/ { gate = 1 }
		in_fn && is_optout { gate = 1 }
		in_fn && /^\}\)/ {
			if (!gate) print FILENAME ":" name
			in_fn = 0
		}
		(!is_comment && !is_export) { block_optout = 0 }
	' {} \; 2>/dev/null | sort || true)

new=$(comm -23 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count new authedQuery definition(s) with no authorization decision."
	echo ""
	echo "$new"
	echo ""
	echo "authedQuery only requires an authenticated org member (any role). A read"
	echo "must also decide WHO may see the data:"
	echo "  - call requireOrgPermission / requireAdminContext / loadOwnedMailbox / etc., or"
	echo "  - add a '// authz: <reason>' (gate lives elsewhere) or"
	echo "    '// all-members: <reason>' (intentionally member-visible) comment."
	echo "Do NOT add new entries to $baseline_file — it is frozen debt."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $baseline_file (query fixed or removed):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines so the ratchet only moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

baseline_count=$(grep -c . "$baseline_file")
echo "ok:   no new authedQuery without an authorization decision ($baseline_count baseline entries remain)"
