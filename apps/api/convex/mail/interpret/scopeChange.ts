/**
 * Mailbox scope change (SPEC §5 "Scope change"): a personal mailbox that
 * becomes a team inbox (`mail/teamInboxConversion.ts`) moves its threads from
 * `brief` to `actions` mode, and what brief mode produced is incompatible:
 *
 *  - `threadFacts` and the `fact_changed` activity about them (actions mode
 *    has no facts);
 *  - `threadBriefs.overview` (the compaction cache) and the checkpoint;
 *  - every `messageInterpretations` row of the thread in the OLD mode (taken
 *    out of the source counters): its sealed payload carries the latest lines
 *    and facts the per-message "latest" reads, and a stored extraction is
 *    replayed instead of re-run, so a brief-mode row would keep a later
 *    actions-mode run from ever happening (the reverse holds for actions →
 *    brief). A row a new-mode run already wrote stays;
 *  - every viewer's `viewOverride` (team surfaces have no Overview switch);
 *  - the thread's response plans (marked `stale`);
 *  - `mailThreads.briefTop`, recomputed in the new mode (no latest line).
 *
 * Items carry over: both modes produce them. The brief row takes the new
 * mode (the reducer reconciles the mode the same way on its next run and
 * sends an old-mode run back with `modeChanged`), a bumped deletion epoch
 * (an in-flight run that loaded before gets `erased`) and the completeness
 * of what is left (`none` once the extractions are gone). The eligibility
 * snapshots (`interpretSources`) do not depend on the mode and stay.
 * Nothing is re-interpreted here: a mailbox can hold
 * thousands of threads, and each would cost a model call; the next message
 * of a thread is interpreted in the new mode, and older threads stay as their
 * items left them.
 *
 * `invalidateMailboxThreads` walks the mailbox a page of threads at a time;
 * a thread with more rows than one pass allows continues in
 * `invalidateThreadScope`.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { mailboxScope } from '../mailbox/shared';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import { deleteExtractions, recomputeCompleteness } from './purgeRows';

/** Threads per walker transaction. */
const THREAD_PAGE = 25;
/** Rows of one table removed or rewritten per thread and pass. */
const ROW_LIMIT = 200;
/** Activity rows scanned per thread for `fact_changed`. */
const ACTIVITY_SCAN = 500;

/** The mode a mailbox's threads interpret in. */
function modeOfScope(mailbox: Pick<Doc<'mailboxes'>, 'scope'>): InterpretMode {
	return mailboxScope(mailbox) === 'shared' ? 'actions' : 'brief';
}

/**
 * Start invalidating every thread of `mailboxId` for its new mode. Call in
 * the transaction that changes the mailbox's scope.
 */
export async function scheduleScopeInvalidation(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	mode: InterpretMode
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
		mailboxId,
		mode,
		cursor: null,
	});
}

/**
 * Drop what one thread's old mode produced and move its brief to `mode` (see
 * the module doc). Returns whether the thread is done; a thread with more
 * rows than one pass allows needs another call.
 */
export async function invalidateThreadForMode(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	mode: InterpretMode
): Promise<boolean> {
	const brief = await loadBriefRow(ctx, { kind: 'mail', id: threadId });
	if (!brief) {
		const thread = await ctx.db.get(threadId);
		if (thread?.briefTop) await ctx.db.patch(threadId, { briefTop: undefined });
		return true;
	}
	let isDone = true;

	// Bump first: an old-mode run that loaded before this pass gets `erased`.
	await ctx.db.patch(brief._id, {
		mode,
		deletionEpoch: brief.deletionEpoch + 1,
		interpretationRevision: brief.interpretationRevision + 1,
		overview: undefined,
		checkpoint: undefined,
		updatedAt: Date.now(),
	});

	// Extractions in the old mode; a run that already landed in the new one stays.
	const extractions = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.take(ROW_LIMIT);
	const stale = extractions.filter((row) => row.mode !== mode);
	await deleteExtractions(ctx, stale);
	// Another pass only while it still finds old-mode rows to delete.
	if (extractions.length === ROW_LIMIT && stale.length > 0) isDone = false;

	if (mode === 'actions') {
		const facts = await ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.take(ROW_LIMIT);
		for (const row of facts) await ctx.db.delete(row._id);
		if (facts.length === ROW_LIMIT) isDone = false;
		const activity = await ctx.db
			.query('threadActivity')
			.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', threadId))
			.order('desc')
			.take(ACTIVITY_SCAN);
		for (const row of activity) {
			if (row.type === 'fact_changed') await ctx.db.delete(row._id);
		}
	}

	const viewers = await ctx.db
		.query('threadViewerState')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.take(ROW_LIMIT);
	for (const row of viewers) {
		if (row.viewOverride !== undefined) {
			await ctx.db.patch(row._id, { viewOverride: undefined, updatedAt: Date.now() });
		}
	}
	if (viewers.length === ROW_LIMIT) isDone = false;

	const plans = await ctx.db
		.query('draftResponsePlans')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.take(ROW_LIMIT);
	for (const plan of plans) {
		if (plan.verdict !== 'stale') {
			await ctx.db.patch(plan._id, { verdict: 'stale', updatedAt: Date.now() });
		}
	}

	await ctx.db.patch(brief._id, {
		completeness: await recomputeCompleteness(ctx, { kind: 'mail', id: threadId }),
	});
	await refreshBriefTop(ctx, threadId, { latest: null });
	return isDone;
}

/**
 * One page of a mailbox's threads. Stops when the mailbox is gone or its
 * scope no longer matches `mode` (a later change runs its own walk).
 */
export async function invalidateMailboxThreads(
	ctx: MutationCtx,
	args: { mailboxId: Id<'mailboxes'>; mode: InterpretMode; cursor: string | null }
): Promise<{ isDone: boolean; threads: number }> {
	const mailbox = await ctx.db.get(args.mailboxId);
	if (!mailbox || modeOfScope(mailbox) !== args.mode) return { isDone: true, threads: 0 };
	const page = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
		.paginate({ cursor: args.cursor, numItems: THREAD_PAGE });
	for (const thread of page.page) {
		if (!(await invalidateThreadForMode(ctx, thread._id, args.mode))) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.invalidateThreadScope, {
				threadId: thread._id,
				mode: args.mode,
			});
		}
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
			...args,
			cursor: page.continueCursor,
		});
	}
	return { isDone: page.isDone, threads: page.page.length };
}

/** Continuation for one thread with more rows than a pass allows. */
export async function invalidateThreadScope(
	ctx: MutationCtx,
	args: { threadId: Id<'mailThreads'>; mode: InterpretMode }
): Promise<{ isDone: boolean }> {
	const thread = await ctx.db.get(args.threadId);
	const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
	if (!mailbox || modeOfScope(mailbox) !== args.mode) return { isDone: true };
	const isDone = await invalidateThreadForMode(ctx, args.threadId, args.mode);
	if (!isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.invalidateThreadScope, args);
	}
	return { isDone };
}
