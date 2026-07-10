/**
 * Shared-mailbox membership — backfill an implicit 'owner' membership row for
 * every existing `mailboxes` row so the access model (mail/permissions.ts) has
 * a single source of truth: from now on, mailbox access is either org
 * owner/admin, the mailbox's own `userId`, or an explicit `mailboxMembers`
 * row. Existing mailboxes predate the table, so they need their owner row
 * written once.
 *
 * Idempotent: a mailbox that already has an 'owner' membership for its
 * `userId` is skipped, so re-running is a no-op. Pre-prod, single org per
 * deployment — the mailbox set is bounded, so this runs synchronously against
 * `.collect()`. Mirrors migrations/0033.
 *
 * `scope` is intentionally left untouched: undefined ⇒ 'personal', which is
 * the correct default for every pre-existing mailbox.
 */

import { internalMutation } from '../_generated/server';

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let created = 0;
		const mailboxes = await ctx.db.query('mailboxes').collect(); // bounded: one-shot pre-prod migration (single org per deployment)
		for (const mailbox of mailboxes) {
			const existing = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailbox._id).eq('authUserId', mailbox.userId)
				)
				.unique();
			if (existing) continue; // already backfilled

			await ctx.db.insert('mailboxMembers', {
				mailboxId: mailbox._id,
				authUserId: mailbox.userId,
				role: 'owner',
				addedBy: mailbox.userId, // self — the implicit owner predates member management
				createdAt: mailbox.createdAt,
			});
			created++;
		}
		return { created };
	},
});
