/**
 * The id-only read behind the thread list's "Select all N matching" escape
 * hatch.
 *
 * The header checkbox alone can only reach the rows the client has actually
 * paged in; a folder with 4 000 messages would silently mean "select these
 * 50". This view answers the other question — which message ids does the
 * current folder scope hold — without shipping a single row body, so a bulk
 * archive can address the whole folder in one round trip.
 *
 * Deliberately BOUNDED rather than paginated: the cap is the promise. A
 * caller learns from `capped` that more ids exist than it received, and the
 * UI says "the first 500" instead of claiming a whole-folder selection it
 * cannot honour. `sortOrder` mirrors `queries.listMessages` so the ids the cap
 * keeps are the ones at the top of the list the user is looking at.
 *
 * Sibling of `mailbox/queries.ts` (the row-shaped list views); split out so
 * that file stays under the size ratchet.
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import { mailSortOrderValidator } from '../../lib/mailSettingsValidators';
import type { Id } from '../../_generated/dataModel';
import { loadReadableMailbox } from '../permissions';
import { isMessageSnoozed } from '../../lib/mailSnooze';
import type { FolderRole } from './shared';

/**
 * Hard ceiling on one "select all matching" answer. Matches the per-batch cap
 * the bulk mutations (`labels.setOnMessages`, `snooze.snoozeMany`,
 * `messageActions.*`) can chew through in a single transaction, so a selection
 * this query hands out is always one the follow-up action can apply whole.
 */
export const BULK_SELECTION_CAP = 500;

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listMessageIds = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		folderRole: v.optional(v.string()),
		folderId: v.optional(v.id('mailFolders')),
		sortOrder: v.optional(mailSortOrderValidator),
	},
	handler: async (ctx, args) => {
		const empty = { ids: [] as Id<'mailMessages'>[], capped: false };
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return empty;

		const now = Date.now();
		const order = args.sortOrder === 'oldest' ? ('asc' as const) : ('desc' as const);
		// One over the cap, so `capped` reports "there are more" rather than
		// guessing from a full page.
		const probe = BULK_SELECTION_CAP + 1;
		const visible = (rows: Array<{ _id: Id<'mailMessages'>; snoozedUntil?: number }>) => ({
			ids: rows.slice(0, BULK_SELECTION_CAP).map((m) => m._id),
			capped: rows.length > BULK_SELECTION_CAP,
		});

		// Virtual "Snoozed" view — the rows deferred out of their folder.
		if (args.folderRole === 'snoozed') {
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_snoozed', (q) =>
					q.eq('mailboxId', args.mailboxId).gt('snoozedUntil', now)
				)
				.take(probe);
			return visible(rows);
		}

		// Custom folder addressed by id — ownership re-checked, never inferred
		// from the id being well-formed.
		if (args.folderId) {
			const folder = await ctx.db.get(args.folderId);
			if (!folder || folder.mailboxId !== args.mailboxId) return empty;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order(order)
				.take(probe);
			return visible(rows.filter((m) => !isMessageSnoozed(m, now)));
		}

		if (args.folderRole) {
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('role', args.folderRole as FolderRole)
				)
				.first();
			if (!folder) return empty;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folder._id))
				.order(order)
				.take(probe);
			// A snooze whose wake time has passed but whose sweep has not run yet
			// is still IN the folder for the list, so filter on the same predicate
			// the list uses rather than on the column's mere presence.
			return visible(rows.filter((m) => !isMessageSnoozed(m, now)));
		}

		// No folder scope (the label view's host): the whole mailbox by arrival.
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order(order)
			.take(probe);
		return visible(rows.filter((m) => !isMessageSnoozed(m, now)));
	},
});
