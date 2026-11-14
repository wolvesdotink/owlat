#!/usr/bin/env bash
# Gates server-to-public calls (`ctx.runQuery(api.…)`, `ctx.runMutation(api.…)`,
# `ctx.runAction(api.…)`) behind a reviewed allowlist.
#
# A public function built with an authed builder (`lib/authedFunctions.ts`)
# reads the caller's session. Called from a user's own action it inherits that
# session and works. Called from a cron, a scheduled function or a workpool job
# there is no session, so it throws "Not authenticated". The checklist sweep
# catches that throw and records "temporarily unconfirmed"; other paths skip
# their work. Tests that stub the auth check hide it.
#
# Server code that may run without a session calls an internal twin instead
# (an `internalQuery`/`internalMutation` next to the public function that
# shares its handler body; see `domains/mtaSts.ts` `readMtaStsPolicy`). A call
# that only ever runs inside a user's request may stay public: add it below as
# `<file>|<api reference>` with the reason it always has a session.

cd "$(dirname "$0")/.."

ALLOWLIST=(
	# Admin-gated actions a signed-in operator runs from Settings > Domains.
	"convex/domains/dnsVerification.ts|api.domains.domains.getInboundMailConfig"
	"convex/domains/mtaStsVerify.ts|api.domains.mtaSts.getMtaStsGuidance"
	"convex/domains/mtaStsVerify.ts|api.domains.mtaSts.getMtaStsPolicy"
	"convex/mail/mailboxMoveActions.ts|api.mail.mailboxMove.moveStatus"
	# Mailbox actions a member triggers; the delegated function re-checks
	# mailbox access on that member's session.
	"convex/mail/mute.ts|api.mail.messageActions.move"
	"convex/mail/subscriptions.ts|api.mail.messageActions.move"
	"convex/mail/subscriptions.ts|api.mail.subscriptions.list"
	"convex/mail/subscriptions.ts|api.mail.subscriptions.sendersOfMessages"
	"convex/mail/ai/gate.ts|api.mail.mailbox.messages.listThreadMessages"
	"convex/mail/ai/voiceGuidance.ts|api.mail.mailbox.identity.get"
	"convex/mail/external/oauthConnect.ts|api.mail.external.accounts.getForCurrentUser"
	"convex/mail/external/oauthConnect.ts|api.mail.external.sharedInbox.getSharedExternalAccount"
	# An approved MCP action runs inside the approving owner's session.
	"convex/mcp/actionRun.ts|api.mail.drafts.create"
	"convex/mcp/actionRun.ts|api.mail.drafts.update"
	"convex/mcp/actionRun.ts|api.mail.drafts.send"
	"convex/mcp/actionRun.ts|api.mail.messageActions.archive"
	"convex/mcp/actionRun.ts|api.mail.messageActions.move"
	"convex/mcp/actionRun.ts|api.mail.labels.toggleOnThread"
	# NOT session-safe: campaign pre-flight also runs at a scheduled start.
	# Listed only so this gate can land before that call moves to
	# `checkEmailDomainVerification`; drop the entry with that change.
	"convex/campaigns/preflight.ts|api.domains.domains.getEmailDomainVerificationStatus"
)

# Every call site as `<file>|<api reference>`, also when the reference sits on
# the line after `ctx.runQuery(`.
found=$(find convex -name '*.ts' -not -path '*/_generated/*' -not -path '*/__tests__/*' -print0 \
	| xargs -0 perl -0ne 'while (/\brun(?:Query|Mutation|Action)\(\s*(api\.[\w.]+)/g) { print "$ARGV|$1\n" }' \
	| sort -u)

violations=""
while IFS= read -r site; do
	[ -z "$site" ] && continue
	allowed=0
	for entry in "${ALLOWLIST[@]}"; do
		if [ "$site" = "$entry" ]; then
			allowed=1
			break
		fi
	done
	[ "$allowed" -eq 0 ] && violations+="  ${site}"$'\n'
done <<<"$found"

if [ -n "$violations" ]; then
	echo "FAIL: server code calls a public function outside the allowlist:"
	printf '%s' "$violations"
	echo ""
	echo "A public function reads the caller's session, and a cron, scheduled function or"
	echo "workpool job has none. Call an internal twin that shares the handler body. If the"
	echo "call only ever runs inside a user's request, add it to ALLOWLIST in"
	echo "scripts/check-server-api-calls.sh with the reason."
	exit 1
fi

# An entry whose call is gone is reported but does not fail: the call may be
# removed by a change that does not touch this file.
for entry in "${ALLOWLIST[@]}"; do
	if ! grep -qxF "$entry" <<<"$found"; then
		echo "note: allowlist entry has no call site any more, remove it: $entry"
	fi
done

echo "OK: every server-to-public call is allowlisted."
