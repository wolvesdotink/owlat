/**
 * Run one filter over EXISTING mail — the backlog a new rule was written for.
 *
 * A filter only ever sees mail that arrives after it: the pile that motivated
 * writing it stays exactly as it was. This walks `mailMessages` by cursor,
 * re-evaluates the filter's conditions per page with the SAME predicate the
 * delivery pipeline uses (`filters.filterConditionsMatch`), and applies its
 * actions — one bounded page per transaction, rescheduling itself, with a job
 * row for progress and cancel. Same shape as `mail/attachmentBackfill.ts`.
 *
 * SAFE ACTIONS ONLY. `forward`, `delete` and `discard` are skipped: they are
 * irreversible and were authored for the inbound moment, not for a retroactive
 * sweep over years of mail. Mailing a decade of archive to a forwarding address
 * because a rule mentioned it is not a feature. `moveToFolder`, `addLabel`,
 * `markRead`, `markFlagged` and `pinToSection` all run, and each is undoable by
 * hand.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { evalMessageFromRow, filterConditionsMatch } from './filters';
import { moveMessagesToFolder, rebuildThreadAggregates } from './messageActions';
import { isMessageSnoozed } from '../lib/mailSnooze';

/**
 * Messages read per transaction. Smaller than the attachment backfill's page:
 * a matching row here can move folders and rewrite two folders' counters, so
 * the write budget binds well before the read budget does.
 */
export const FILTER_RUN_BATCH = 64;

/** Action types a retroactive sweep is allowed to perform. */
const SAFE_ACTION_TYPES = new Set([
	'moveToFolder',
	'addLabel',
	'markRead',
	'markFlagged',
	// Split inbox (idea 24). Safe by the same test as the others: it only
	// rearranges where a message READS in the inbox, moves nothing out of sight,
	// and is undone by deleting the rule — the stamp then names no rendered
	// section, so `mail/sections.ts` reads the mail back under "Everything else".
	'pinToSection',
]);

/**
 * Does this filter do anything a retroactive run can perform? A rule that only
 * forwards or deletes has nothing safe to apply, and the UI uses this to say so
 * instead of offering a run that would silently do nothing.
 */
export function hasRetroactiveActions(filter: Pick<Doc<'mailFilters'>, 'actions'>): boolean {
	return filter.actions.some((action) => SAFE_ACTION_TYPES.has(action.type));
}

/** The current run for a filter, or null. Drives the progress strip. */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const status = publicQuery({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args) => {
		const filter = await ctx.db.get(args.filterId);
		if (!filter) return null;
		const owned = await requireMailboxAccess(ctx, filter.mailboxId);
		if (!owned.ok) return null;
		return ctx.db
			.query('mailFilterRunJobs')
			.withIndex('by_filter', (q) => q.eq('filterId', args.filterId))
			.first();
	},
});

/**
 * Start (or restart) a retroactive run. Owner-grade, matching filter CRUD: the
 * sweep rewrites mail for everyone who uses the mailbox.
 *
 * A run already in flight is left alone rather than forked, so a double click
 * cannot produce two walks racing over one cursor.
 */
export const start = authedMutation({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args): Promise<{ started: boolean }> => {
		const filter = await getOrThrow(ctx, args.filterId, 'Filter');
		const owned = await requireMailboxAccess(ctx, filter.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Filter not accessible');

		const existing = await ctx.db
			.query('mailFilterRunJobs')
			.withIndex('by_filter', (q) => q.eq('filterId', args.filterId))
			.first();
		if (existing?.status === 'running') return { started: false };

		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				status: 'running',
				cursor: undefined,
				scannedCount: 0,
				matchedCount: 0,
				startedAt: now,
				updatedAt: now,
				finishedAt: undefined,
				errorMessage: undefined,
			});
		} else {
			await ctx.db.insert('mailFilterRunJobs', {
				mailboxId: filter.mailboxId,
				filterId: args.filterId,
				status: 'running',
				scannedCount: 0,
				matchedCount: 0,
				startedAt: now,
				updatedAt: now,
			});
		}
		await ctx.scheduler.runAfter(0, internal.mail.filterRun.runBatch, {
			filterId: args.filterId,
		});
		return { started: true };
	},
});

/**
 * Stop a running sweep. Everything already applied stays applied — a cancelled
 * run is a partial sweep, and re-running simply walks the mailbox again (the
 * actions are idempotent: a label already on a message, a flag already set, a
 * message already in the target folder are all no-ops).
 */
export const cancel = authedMutation({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args): Promise<void> => {
		const filter = await getOrThrow(ctx, args.filterId, 'Filter');
		const owned = await requireMailboxAccess(ctx, filter.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Filter not accessible');
		const job = await ctx.db
			.query('mailFilterRunJobs')
			.withIndex('by_filter', (q) => q.eq('filterId', args.filterId))
			.first();
		if (!job || job.status !== 'running') return;
		const now = Date.now();
		await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
	},
});

/**
 * Apply one filter's safe actions to one message. Every branch is a no-op when
 * the message is already in the requested state, which is what makes a re-run
 * (after a cancel, or a second click) harmless.
 */
async function applyActions(
	ctx: MutationCtx,
	filter: Doc<'mailFilters'>,
	message: Doc<'mailMessages'>
): Promise<void> {
	const flagPatch: { flagSeen?: boolean; flagFlagged?: boolean; pinnedSection?: string } = {};
	let labelIds = message.labelIds;

	for (const action of filter.actions) {
		if (action.type === 'markRead' && !message.flagSeen) flagPatch.flagSeen = true;
		else if (action.type === 'markFlagged' && !message.flagFlagged) flagPatch.flagFlagged = true;
		else if (
			// FIRST pin wins, mirroring the delivery-time precedence in
			// deliveryPipeline/routing.ts — a message belongs to one section.
			action.type === 'pinToSection' &&
			action.sectionName &&
			flagPatch.pinnedSection === undefined &&
			message.pinnedSection !== action.sectionName
		) {
			flagPatch.pinnedSection = action.sectionName;
		} else if (action.type === 'addLabel' && action.labelId) {
			// A label from another mailbox can only be a stale reference; applying
			// it would put a foreign id on the row.
			const label = await ctx.db.get(action.labelId);
			if (!label || label.mailboxId !== message.mailboxId) continue;
			if (!labelIds.includes(action.labelId)) labelIds = [...labelIds, action.labelId];
		}
	}

	if (Object.keys(flagPatch).length > 0 || labelIds !== message.labelIds) {
		const now = Date.now();
		const folder = await ctx.db.get(message.folderId);
		// Bump the folder's modseq so IMAP CONDSTORE clients see the change, and
		// decrement `unseenCount` when a row goes read — otherwise the rail badge
		// outlives the mail it counted.
		//
		// A snoozed message was never in `unseenCount` (the counter tracks unread
		// AND not-snoozed; `snooze.ts` adjusts it when the flag flips), so marking
		// one read must leave the counter alone — mirrors `applyFlagDelta` in
		// `messageActions.ts`. Without this a retroactive sweep over a mailbox
		// holding snoozed unread mail permanently undercounts the folder badge.
		const wasCounted = flagPatch.flagSeen === true && !isMessageSnoozed(message, now);
		const modseq = folder ? folder.highestModseq + 1 : message.modseq;
		if (folder) {
			await ctx.db.patch(folder._id, {
				highestModseq: modseq,
				...(wasCounted ? { unseenCount: Math.max(0, folder.unseenCount - 1) } : {}),
				updatedAt: now,
			});
		}
		await ctx.db.patch(message._id, { ...flagPatch, labelIds, modseq, updatedAt: now });
		await rebuildThreadAggregates(ctx, message.threadId);
	}

	// The move goes last so the flag/label writes above act on the row while it
	// is still in its original folder, keeping that folder's counters right.
	const move = filter.actions.find((a) => a.type === 'moveToFolder' && a.folderId);
	if (move?.folderId && move.folderId !== message.folderId) {
		const target = await ctx.db.get(move.folderId);
		if (target && target.mailboxId === message.mailboxId) {
			await moveMessagesToFolder(ctx, {
				messageIds: [message._id],
				targetFolderId: move.folderId,
			});
		}
	}
}

/**
 * One page of the sweep, then reschedule. The job row is re-read every batch so
 * a `cancel` between pages actually stops it; the filter is re-read too, so
 * deleting or editing the rule mid-walk ends (or updates) the sweep rather than
 * letting a stale copy finish applying a rule that no longer exists.
 */
export const runBatch = internalMutation({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args): Promise<void> => {
		const job = await ctx.db
			.query('mailFilterRunJobs')
			.withIndex('by_filter', (q) => q.eq('filterId', args.filterId))
			.first();
		if (!job || job.status !== 'running') return;

		const now = Date.now();
		const filter = await ctx.db.get(args.filterId);
		if (!filter) {
			await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
			return;
		}

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', job.mailboxId))
			.paginate({ cursor: job.cursor ?? null, numItems: FILTER_RUN_BATCH });

		let matched = 0;
		for (const message of page) {
			if (!filterConditionsMatch(filter, await evalMessageFromRow(message))) continue;
			matched += 1;
			await applyActions(ctx, filter, message);
		}

		await ctx.db.patch(job._id, {
			cursor: isDone ? undefined : continueCursor,
			scannedCount: job.scannedCount + page.length,
			matchedCount: job.matchedCount + matched,
			status: isDone ? 'completed' : 'running',
			updatedAt: Date.now(),
			...(isDone ? { finishedAt: Date.now() } : {}),
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.filterRun.runBatch, {
				filterId: args.filterId,
			});
		}
	},
});

/** Drop a filter's run job — called when the filter itself is deleted. */
export async function removeFilterRunJob(
	ctx: MutationCtx,
	filterId: Id<'mailFilters'>
): Promise<void> {
	const job = await ctx.db
		.query('mailFilterRunJobs')
		.withIndex('by_filter', (q) => q.eq('filterId', filterId))
		.first();
	if (job) await ctx.db.delete(job._id);
}
