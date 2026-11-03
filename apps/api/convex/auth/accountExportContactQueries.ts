import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { throwNotFound } from '../_utils/errors';
import { requireSelf } from '../lib/sessionOrganization';
import { isPersonalMailbox, loadPersonalMailboxForUser } from '../mail/permissions';

// Postbox address-book resource of "Export my data", next to accountExportQueries.ts.

/** Mailboxes a member can own; the manifest counts the books of these. */
const MAILBOX_SCAN_LIMIT = 2_000;
/** Past this many rows the manifest says "more than" (as for every personal count). */
const CONTACT_COUNT_CAP = 2_000;

/**
 * Every row of one of the member's personal address books, whatever built it
 * (mail sent and received, the screener, a vCard import). A team inbox's book
 * belongs to the team and is not exported.
 */
export const listMailboxContacts = internalQuery({
	args: {
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const mailbox = await loadPersonalMailboxForUser(ctx, args.mailboxId, args.userId);
		if (!mailbox) throwNotFound('Personal mailbox');
		return ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailbox._id))
			.paginate(args.paginationOpts);
	},
});

/** The address-book line of the pre-run manifest (`getExportPlan`). */
export const countPersonalMailContacts = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const mailboxes = (
			await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', args.userId))
				.take(MAILBOX_SCAN_LIMIT)
		).filter(isPersonalMailbox);
		let count = 0;
		for (const mailbox of mailboxes) {
			const rows = await ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailbox._id))
				.take(CONTACT_COUNT_CAP + 1 - count);
			count += rows.length;
			if (count > CONTACT_COUNT_CAP) break;
		}
		return {
			resource: 'mailContacts' as const,
			count: Math.min(count, CONTACT_COUNT_CAP),
			isCapped: count > CONTACT_COUNT_CAP,
		};
	},
});
