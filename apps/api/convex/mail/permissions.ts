/**
 * Mailbox gate (helper).
 *
 * One canonical permission predicate for every `mail/*` mutation and query
 * operating on a `mailboxes` row. Mirrors `organizations/abuseGate.ts` in
 * role — a read-side check co-located with the area it gates — but is a
 * single function rather than a sibling-paired module family.
 *
 * Outcome shape `{ ok: true; userId; mailbox } | { ok: false; reason }`
 * is discriminated on `reason` so future audit logging or HTTP error
 * mapping can dispatch on the failure mode (no_session / mailbox_missing
 * / mailbox_inactive / forbidden).
 *
 * Policy (preserved from the eleven pre-deepening clones, extended for
 * shared mailboxes):
 *   - Session must exist with a role.
 *   - Mailbox must exist and `status === 'active'` — read paths refuse on
 *     suspended/deleted alongside writes.
 *   - Caller must be one of:
 *       · org 'owner' / 'admin' (acting on behalf of any user in the org),
 *       · `mailbox.userId === s.userId` (the mailbox's own user — always
 *         owner-level access), or
 *       · a member of the mailbox via a `mailboxMembers` row whose `role`
 *         meets the requested `minRole` (this is what grants a teammate
 *         access to a *shared* inbox; org membership alone grants nothing).
 *
 * Personal mailboxes carry only a single implicit 'owner' membership for
 * their own `userId`, which the `mailbox.userId === s.userId` clause already
 * covers — so this leaves personal-mailbox behaviour bit-for-bit unchanged.
 *
 * See `CONTEXT.md` § Postbox mailbox for terminology.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';

/** Membership role on a mailbox. `owner` is a superset of `member`. */
export type MailboxMemberRole = 'owner' | 'member';

/** Does `role` satisfy the required `minRole`? `owner` satisfies both. */
function roleSatisfies(role: MailboxMemberRole, minRole: MailboxMemberRole): boolean {
	return minRole === 'member' || role === 'owner';
}

export type MailboxAccessOutcome =
	| { ok: true; userId: string; mailbox: Doc<'mailboxes'> }
	| {
			ok: false;
			reason: 'no_session' | 'mailbox_missing' | 'mailbox_inactive' | 'forbidden';
	  };

export async function loadOwnedMailbox(
	ctx: Parameters<typeof getBetterAuthSessionWithRole>[0],
	mailboxId: Id<'mailboxes'>,
	minRole: MailboxMemberRole = 'member'
): Promise<MailboxAccessOutcome> {
	const s = await getBetterAuthSessionWithRole(ctx);
	if (!s || !s.role) return { ok: false, reason: 'no_session' };
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox) return { ok: false, reason: 'mailbox_missing' };
	if (mailbox.status !== 'active') return { ok: false, reason: 'mailbox_inactive' };
	// Org owner/admin act on behalf of any user in the org, and the mailbox's
	// own user always has owner-level access — both bypass the membership read.
	if (s.role === 'owner' || s.role === 'admin' || mailbox.userId === s.userId) {
		return { ok: true, userId: s.userId, mailbox };
	}
	// Everyone else needs an explicit membership row meeting `minRole`. This is
	// the only path that reaches a shared mailbox; personal mailboxes never
	// carry non-owner members, so their behaviour is unchanged.
	const membership = await ctx.db
		.query('mailboxMembers')
		.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailboxId).eq('authUserId', s.userId))
		.unique();
	if (membership && roleSatisfies(membership.role, minRole)) {
		return { ok: true, userId: s.userId, mailbox };
	}
	return { ok: false, reason: 'forbidden' };
}

/**
 * Read-side counterpart to {@link loadOwnedMailbox}: same ownership +
 * `status === 'active'` policy, but collapsed to a plain
 * `Doc<'mailboxes'> | null` for the query soft-fail pattern (a `publicQuery`
 * that returns an empty/null result for anonymous, non-owner, or
 * suspended/deleted mailboxes instead of throwing).
 *
 * Use this in the mailbox read handlers (get / listMessages / listThreads /
 * listFolders / search / identity listing) so they share the one predicate —
 * crucially including the active-status clause the old inlined copies omitted,
 * which left a soft-deleted/suspended mailbox readable by id.
 */
export async function loadReadableMailbox(
	ctx: Parameters<typeof getBetterAuthSessionWithRole>[0],
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailboxes'> | null> {
	const owned = await loadOwnedMailbox(ctx, mailboxId);
	return owned.ok ? owned.mailbox : null;
}

export type MessageAccessOutcome =
	| {
			ok: true;
			userId: string;
			mailbox: Doc<'mailboxes'>;
			message: Doc<'mailMessages'>;
	  }
	| {
			ok: false;
			reason:
				| 'no_session'
				| 'message_missing'
				| 'mailbox_missing'
				| 'mailbox_inactive'
				| 'forbidden';
	  };

/** Same policy as {@link loadOwnedMailbox}, keyed by a message id. */
export async function loadOwnedMessage(
	ctx: Parameters<typeof getBetterAuthSessionWithRole>[0],
	messageId: Id<'mailMessages'>
): Promise<MessageAccessOutcome> {
	const message = await ctx.db.get(messageId);
	if (!message) return { ok: false, reason: 'message_missing' };
	const owned = await loadOwnedMailbox(ctx, message.mailboxId);
	if (!owned.ok) return owned;
	return { ok: true, userId: owned.userId, mailbox: owned.mailbox, message };
}
