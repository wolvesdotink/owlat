/**
 * Trash auto-purge (idea 67) — the sweep behind the "Your data" card's horizon.
 *
 * Owlat has never emptied anyone's bin: a trashed message sat there until the
 * owner used "Delete forever". That is a defensible default and it stays the
 * default — this sweep only ever looks at users who set
 * `mailUserSettings.trashAutoPurgeDays` to a non-zero horizon. An absent or
 * zero setting means "Never", and for those users nothing here does anything.
 *
 * The age it measures is TIME IN THE BIN (`mailMessages.trashedAt`), not time
 * since the message arrived: "delete after 30 days" must mean 30 days after the
 * user threw it away, or the first sweep would erase a decade of just-trashed
 * mail. Rows trashed before `trashedAt` existed carry no stamp at all, and the
 * sweep SKIPS them rather than guessing — an unknown age is not an old one, and
 * a retention job that destroys mail on a guess is unforgivable.
 *
 * Deletion goes through `purgeMessageRow`, the same helper the manual "Delete
 * forever" uses, so folder counters, `usedBytes`, blobs and the attachment index
 * all move exactly as they do for a manual purge.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { purgeMessageRow } from './messagePurge';
import { rebuildThreadAggregates } from './threadAggregates';

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Settings rows examined per sweep run. */
export const TRASH_RETENTION_SETTINGS_BATCH = 32;
/** Messages deleted per settings row per run. The next tick continues. */
export const TRASH_RETENTION_PURGE_BATCH = 64;

/**
 * Delete one page of expired trash for one owner.
 *
 * Bounded twice over — a page of settings rows, and a page of messages per
 * owner — so a mailbox with a hundred thousand trashed messages drains over
 * successive cron ticks instead of blowing one mutation's budget.
 */
export const sweepExpiredTrash = internalMutation({
	args: {
		cursor: v.optional(v.string()),
		startedAt: v.optional(v.number()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ examined: number; purged: number; continuationScheduled: boolean }> => {
		const startedAt = args.startedAt ?? Date.now();
		const page = await ctx.db.query('mailUserSettings').paginate({
			cursor: args.cursor ?? null,
			numItems: TRASH_RETENTION_SETTINGS_BATCH,
		});

		let purged = 0;
		for (const settings of page.page) {
			const days = settings.trashAutoPurgeDays ?? 0;
			if (days <= 0) continue;
			const cutoff = startedAt - days * DAY_MS;

			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', settings.userId))
				.collect(); // bounded: one person's mailboxes
			for (const mailbox of mailboxes) {
				// A shared team inbox is org infrastructure; one member's personal
				// retention preference must not empty everyone else's bin.
				if (mailbox.scope === 'shared' || mailbox.status !== 'active') continue;
				const trash = await ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox_and_role', (q) =>
						q.eq('mailboxId', mailbox._id).eq('role', 'trash')
					)
					.first();
				if (!trash) continue;

				// `gte(0)` excludes the un-stamped rows outright: an optional field
				// sorts below every number, so without the lower bound they would
				// fill every batch and no expired message would ever be reached.
				const candidates = await ctx.db
					.query('mailMessages')
					.withIndex('by_folder_and_trashed', (q) =>
						q.eq('folderId', trash._id).gte('trashedAt', 0).lt('trashedAt', cutoff)
					)
					.take(TRASH_RETENTION_PURGE_BATCH);
				const touchedThreads = new Set<Id<'mailThreads'>>();
				for (const message of candidates) {
					if (message.trashedAt === undefined || message.trashedAt >= cutoff) continue;
					touchedThreads.add(await purgeMessageRow(ctx, message));
					purged++;
				}
				for (const threadId of touchedThreads) await rebuildThreadAggregates(ctx, threadId);
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.trashRetention.sweepExpiredTrash, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return {
			examined: page.page.length,
			purged,
			continuationScheduled: !page.isDone,
		};
	},
});
