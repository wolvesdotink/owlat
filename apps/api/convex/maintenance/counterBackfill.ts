/**
 * The backfill walk behind the maintained counts (plan 3.1).
 *
 * A scope that existed before its counters did is counted by walking its
 * source index one bounded page per mutation, rescheduling itself until the
 * walk is done; `lib/counters.ts` explains why writes that race the walk are
 * still counted exactly once. Progress is durable: the cursor and watermark
 * live on the scope's `counterScopes` row, so a walk that dies (a failed step,
 * a redeploy mid-chain) resumes from its last page when it is kicked again,
 * and a second chain running beside the first only takes turns with it.
 *
 * Started for existing data by `migrations/0048_backfill_counters`; a new
 * mailbox starts its scopes ready (`mail/messageCounters.startEmptyMailboxCounters`).
 */

import { v } from 'convex/values';
import type { PaginationResult } from 'convex/server';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import {
	applyCounterBackfillPage,
	creationPosition,
	loadCounterScope,
	type CounterBackfillPage,
	type CounterPosition,
} from '../lib/counters';
import { listingCounterBuckets } from '../lib/listingCounters';
import { contactGrowthBuckets, contactLiveBuckets } from '../contacts/growthCounters';
import {
	arrivalBuckets,
	labelUnreadBuckets,
	messagePosition,
	sectionUnreadBuckets,
} from '../mail/messageCounters';

/** Message rows still carry inline bodies (up to 64 KB each), so their pages stay small. */
const MESSAGE_PAGE = 64;
const ROW_PAGE = 256;

function toPage<T>(
	result: PaginationResult<T>,
	position: (row: T) => CounterPosition,
	buckets: (row: T) => readonly string[]
): CounterBackfillPage {
	return {
		items: result.page.map((row) => ({ position: position(row), buckets: buckets(row) })),
		continueCursor: result.continueCursor,
		isDone: result.isDone,
	};
}

/**
 * Read the next page of a scope's source rows. Null when the scope's owner (a
 * mailbox or folder id) no longer parses, which ends the scope.
 */
async function walkCounterScope(
	ctx: MutationCtx,
	state: Doc<'counterScopes'>,
	pageSize: number | undefined
): Promise<CounterBackfillPage | null> {
	const page = (numItems: number) => ({ cursor: state.cursor, numItems: pageSize ?? numItems });
	switch (state.kind) {
		case 'mailLabelUnread': {
			const mailboxId = ctx.db.normalizeId('mailboxes', state.ownerId ?? '');
			if (!mailboxId) return null;
			const result = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.paginate(page(MESSAGE_PAGE));
			return toPage(result, messagePosition, labelUnreadBuckets);
		}
		case 'mailSectionUnread':
		case 'mailFolderArrivals': {
			const folderId = ctx.db.normalizeId('mailFolders', state.ownerId ?? '');
			if (!folderId) return null;
			const result = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_received', (q) => q.eq('folderId', folderId))
				.paginate(page(MESSAGE_PAGE));
			const buckets = state.kind === 'mailSectionUnread' ? sectionUnreadBuckets : arrivalBuckets;
			return toPage(result, messagePosition, buckets);
		}
		case 'campaignStatus': {
			const result = await ctx.db.query('campaigns').paginate(page(ROW_PAGE));
			return toPage(result, creationPosition, (row) =>
				listingCounterBuckets('campaignStatus', row)
			);
		}
		case 'templateType': {
			const result = await ctx.db.query('emailTemplates').paginate(page(ROW_PAGE));
			return toPage(result, creationPosition, (row) => listingCounterBuckets('templateType', row));
		}
		case 'automationStatus': {
			const result = await ctx.db.query('automations').paginate(page(ROW_PAGE));
			return toPage(result, creationPosition, (row) =>
				listingCounterBuckets('automationStatus', row)
			);
		}
		case 'contactCreatedDay': {
			const result = await ctx.db.query('contacts').paginate(page(ROW_PAGE));
			return toPage(result, creationPosition, contactGrowthBuckets);
		}
		case 'contactLiveTotal': {
			// Driven by `contacts/countReconcile.ts`, which also finalizes it; this
			// case only keeps a generic step on the scope counting correctly.
			const result = await ctx.db.query('contacts').paginate(page(ROW_PAGE));
			return toPage(result, creationPosition, contactLiveBuckets);
		}
	}
}

/**
 * Count one page into `scope`. Returns true while the walk has more pages.
 * Exported (with a page-size override) so a test can drive the walk a few rows
 * at a time between other writes.
 */
export async function runCounterBackfillStep(
	ctx: MutationCtx,
	scope: string,
	pageSize?: number
): Promise<boolean> {
	const state = await loadCounterScope(ctx.db, scope);
	if (!state || state.isReady) return false;
	const page = await walkCounterScope(ctx, state, pageSize);
	if (!page) {
		await ctx.db.delete(state._id);
		return false;
	}
	await applyCounterBackfillPage(ctx, state, page);
	return !page.isDone;
}

export const step = internalMutation({
	args: { scope: v.string() },
	handler: async (ctx, { scope }) => {
		if (await runCounterBackfillStep(ctx, scope)) {
			await ctx.scheduler.runAfter(0, internal.maintenance.counterBackfill.step, { scope });
		}
	},
});
