#!/usr/bin/env bash
# Bans inlining the per-user mailbox-ownership predicate
# (`mailbox.userId !== <session>.userId`) anywhere except the one canonical
# gate, convex/mail/permissions.ts.
#
# Why this is a hard gate, not a style ratchet: the ownership check on a
# `mailboxes` row is also the active-status check. The canonical helpers
# loadOwnedMailbox / loadReadableMailbox in mail/permissions.ts enforce BOTH
# `mailbox.userId === session.userId` (or owner/admin acting on behalf) AND
# `mailbox.status === 'active'`. The pre-deepening read handlers (mailbox.get /
# listMessages / listThreads / listFolders / search / identities.listForOwnedMailbox)
# each re-inlined the ownership boolean but DROPPED the active-status clause, so
# a soft-deleted or suspended mailbox stayed readable by id — exactly the class
# this guard exists to prevent. A new call site that hand-rolls
# `mailbox.userId !== session.userId` would re-introduce that drift.
#
# All mailbox ownership / readability MUST go through mail/permissions.ts:
#   - loadOwnedMailbox(ctx, mailboxId)     — write paths (throw-on-fail)
#   - loadReadableMailbox(ctx, mailboxId)  — read paths (null-on-fail soft auth)
#   - loadOwnedMessage / loadReadableMessage — message-keyed variants
# all of which apply the ownership + active-status policy in one place.

cd "$(dirname "$0")/.."

# Matches a real inline ownership comparison on a mailbox row variable
# (`mailbox` / `mb`), e.g. `mailbox.userId !== session.userId`. Prose mentions
# using `===` in docblocks never match (we only ban the `!==` guard form).
PATTERN='(mailbox|mb)\.userId[[:space:]]*!=='

# The reviewed, policy-enforcing gate. Everything else must call its helpers.
filter() {
	grep -v "/_generated/" \
		| grep -v "/__tests__/" \
		| grep -v "convex/mail/permissions.ts"
}

violations=$(grep -rnE "$PATTERN" convex --include="*.ts" 2>/dev/null | filter || true)

count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count inline mailbox-ownership check(s) outside mail/permissions.ts."
	echo ""
	echo "$violations"
	echo ""
	echo "Do not hand-roll \`mailbox.userId !== session.userId\` — it drops the"
	echo "\`status === 'active'\` clause and lets a soft-deleted/suspended mailbox stay"
	echo "readable by id. Route through mail/permissions.ts:"
	echo "  loadOwnedMailbox    (write paths, throws on fail)"
	echo "  loadReadableMailbox (read paths, returns null on fail)"
	echo "  loadOwnedMessage / loadReadableMessage (message-keyed)"
	exit 1
fi

echo "ok:   no inline mailbox-ownership checks outside mail/permissions.ts"
