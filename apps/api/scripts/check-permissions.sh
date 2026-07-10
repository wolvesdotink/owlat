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
# A site passes when it does ONE of:
#
#   * uses a role-bearing wrapper instead — `adminMutation` / `ownerMutation`
#     (these don't match the bare `authedMutation(`/`authedAction(` pattern, so
#     they're exempt: the gate lives in the wrapper);
#
# NOTE: `chatMutation` / `assistantMutation` (chat/_helpers.ts,
# assistant/conversations.ts) are the exception to the exception. They compose
# `authedMutation` with a `assertFeatureEnabled` FEATURE-flag floor only — a
# feature flag is NOT an authorization decision — so they are matched by the
# is_export regex below and remain SUBJECT to this gate. Each chat/assistant
# write must still make its own in-handler authz decision (assertCanWriteRoom /
# conversation-owner check / requireOrgPermission).
#   * calls a recognized authorization gate inside the handler:
#       requirePermission / requireAdminContext / requireOwnerContext /
#       requireOrgPermission   (org-role RBAC, lib/sessionOrganization.ts)
#       loadOwnedMailbox / loadOwnedMessage   (per-user mail ownership, mail/*)
#       assertCanReadRoom / assertCanWriteRoom / assertCanAdministerRoom
#                              (team-chat membership, chat/_helpers.ts)
#       requirePlatformAdmin   (platform operator, platformAdmin/platformAdmin.ts)
#   * carries an explicit opt-out comment — either inside the handler body, or on
#     the line directly above the `export const`:
#       // authz: <why this needs no role check / where the gate actually lives>
#       // all-members: <why every org member may legitimately do this>
#
# Like check-public-functions.sh this is a HARD gate (baseline 0): a forgotten
# authorization check is a privilege-escalation bug, not style drift, so it must
# fail CI outright. When you add a new gate helper, add its name to the gate
# token regex below.

cd "$(dirname "$0")/.."

# awk walks each file (NR resets per file via find -exec ... {} \;). It tracks
# the span of each `export const X = authedMutation(`/`authedAction(` definition
# — from the export line to the dedented `})` that closes it (top-level defs sit
# at column 0 in this codebase; everything inside the handler is indented, so the
# only column-0 `})` is the definition's own close). A definition is satisfied by
# a gate token / opt-out comment anywhere in its body, OR by an opt-out keyword
# in the contiguous `//` comment block directly above the export. `block_optout`
# is reset by any non-comment, non-export line, so a comment can never leak onto
# an unrelated later definition.
violations=$(find convex -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	-exec awk '
		BEGIN { in_fn = 0; gate = 0; start = 0; name = ""; block_optout = 0 }
		{
			is_comment = ($0 ~ /^[[:space:]]*\/\//)
			is_optout  = ($0 ~ /\/\/[[:space:]]*(authz|all-members):/)
			is_export  = ($0 ~ /^export const [A-Za-z0-9_]+ = (authedMutation|authedAction|chatMutation|assistantMutation)\(/)
		}
		is_comment && is_optout { block_optout = 1 }
		is_export {
			in_fn = 1; start = NR; name = $3
			gate = block_optout
			block_optout = 0
		}
		in_fn && $0 ~ /(requirePermission|requireAdminContext|requireOwnerContext|requireOrgPermission|requireCampaignSendersManage|loadOwnedMailbox|loadOwnedMessage|assertCanReadRoom|assertCanWriteRoom|assertCanAdministerRoom|requirePlatformAdmin)/ { gate = 1 }
		in_fn && is_optout { gate = 1 }
		in_fn && /^\}\)/ {
			if (!gate) print FILENAME ":" start ":" name
			in_fn = 0
		}
		(!is_comment && !is_export) { block_optout = 0 }
	' {} \; 2>/dev/null || true)

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
	echo "    requireAdminContext / requireOrgPermission / loadOwnedMailbox / etc., or"
	echo "  - add a '// authz: <reason>' (gate lives elsewhere) or"
	echo "    '// all-members: <reason>' (intentionally open to every member) comment."
	exit 1
fi

echo "ok:   every authedMutation/authedAction has an explicit authorization decision"
