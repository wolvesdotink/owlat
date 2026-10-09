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
 * `purgeRun.ts invalidateMailboxThreadsPage` walks the mailbox a page of
 * threads at a time and starts a `scope` purge job per thread
 * (`purgeDrain.ts`): the brief row is moved to the new mode and its epoch
 * bumped ONCE, when the job starts ({@link startScopeChange}); the ranges
 * below are walked resumably, each with its own cursor, so a thread with many
 * extractions, viewers, activity rows or plans is finished, never re-read
 * from the start.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { mailboxScope } from '../mailbox/shared';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import { deleteExtractions, recomputeCompleteness } from './purgeRows';
import {
	drainShrinking,
	scanRange,
	type JobPlan,
	type PurgeRange,
	type RangePosition,
	type RangeRun,
} from './purgeDrain';

/** The mode a mailbox's threads interpret in. */
export function modeOfScope(mailbox: Pick<Doc<'mailboxes'>, 'scope'>): InterpretMode {
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
 * The one-time start of a thread's scope change: the brief takes the new
 * mode, a bumped epoch (an old-mode run that loaded before gets `erased`) and
 * revision, no overview and no checkpoint. Returns false when the thread has
 * no brief row (nothing to invalidate; a stale list projection is cleared).
 */
export async function startScopeChange(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	mode: InterpretMode
): Promise<boolean> {
	const brief = await loadBriefRow(ctx, { kind: 'mail', id: threadId });
	if (!brief) {
		const thread = await ctx.db.get(threadId);
		if (thread?.briefTop) await ctx.db.patch(threadId, { briefTop: undefined });
		return false;
	}
	await ctx.db.patch(brief._id, {
		mode,
		deletionEpoch: brief.deletionEpoch + 1,
		interpretationRevision: brief.interpretationRevision + 1,
		overview: undefined,
		checkpoint: undefined,
		updatedAt: Date.now(),
	});
	return true;
}

function mailThreadOf(run: RangeRun): Id<'mailThreads'> | null {
	return run.ref.kind === 'mail' ? run.ref.id : null;
}

/** Rows of a mail-thread table in creation order, from `from`. */
function byCreation(from: RangePosition | undefined) {
	return typeof from === 'number' ? from : undefined;
}

/** 1. The thread's extractions in the old mode (a row a new-mode run wrote stays). */
const extractionsRange: PurgeRange = async (ctx, run) => {
	const threadId = mailThreadOf(run);
	if (!threadId) return { isDone: true };
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) => {
			const at = byCreation(from);
			return ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', threadId)
						: q.eq('mailThreadId', threadId).gt('_creationTime', at)
				)
				.take(n);
		},
		(row) => row._creationTime,
		async (row) => {
			if (row.mode !== run.job.mode) await deleteExtractions(ctx, [row]);
			return true;
		}
	);
};

/** 2. Actions mode has no facts: every fact of the thread goes. */
const factsRange: PurgeRange = async (ctx, run) => {
	const threadId = mailThreadOf(run);
	if (!threadId || run.job.mode !== 'actions') return { isDone: true };
	const isEmpty = await drainShrinking(
		run.budget,
		(n) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.take(n),
		async (row) => {
			await ctx.db.delete(row._id);
			return true;
		}
	);
	return isEmpty ? { isDone: true } : { isDone: false, cursor: undefined };
};

/** 3. ... and the `fact_changed` activity about them, over the whole log. */
const factActivityRange: PurgeRange = async (ctx, run) => {
	const threadId = mailThreadOf(run);
	if (!threadId || run.job.mode !== 'actions') return { isDone: true };
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) =>
			ctx.db
				.query('threadActivity')
				.withIndex('by_mail_thread_and_seq', (q) =>
					typeof from === 'number'
						? q.eq('mailThreadId', threadId).gt('seq', from)
						: q.eq('mailThreadId', threadId)
				)
				.take(n),
		(row) => row.seq,
		async (row) => {
			if (row.type === 'fact_changed') await ctx.db.delete(row._id);
			return true;
		}
	);
};

/** 4. Every viewer's view override (team surfaces have no Overview switch). */
const viewersRange: PurgeRange = async (ctx, run) => {
	const threadId = mailThreadOf(run);
	if (!threadId) return { isDone: true };
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) => {
			const at = byCreation(from);
			return ctx.db
				.query('threadViewerState')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', threadId)
						: q.eq('mailThreadId', threadId).gt('_creationTime', at)
				)
				.take(n);
		},
		(row) => row._creationTime,
		async (row) => {
			if (row.viewOverride !== undefined) {
				await ctx.db.patch(row._id, { viewOverride: undefined, updatedAt: Date.now() });
			}
			return true;
		}
	);
};

/** 5. Every response plan of the thread goes stale. */
const plansRange: PurgeRange = async (ctx, run) => {
	const threadId = mailThreadOf(run);
	if (!threadId) return { isDone: true };
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) => {
			const at = byCreation(from);
			return ctx.db
				.query('draftResponsePlans')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', threadId)
						: q.eq('mailThreadId', threadId).gt('_creationTime', at)
				)
				.take(n);
		},
		(row) => row._creationTime,
		async (plan) => {
			if (plan.verdict !== 'stale') {
				await ctx.db.patch(plan._id, { verdict: 'stale', updatedAt: Date.now() });
			}
			return true;
		}
	);
};

/** The walk of a `scope` job; settling recomputes completeness and the list projection. */
export const scopePlan: JobPlan = {
	ranges: [extractionsRange, factsRange, factActivityRange, viewersRange, plansRange],
	settle: async (ctx, _job, ref) => {
		if (ref.kind !== 'mail') return;
		const brief = await loadBriefRow(ctx, ref);
		if (brief) {
			await ctx.db.patch(brief._id, { completeness: await recomputeCompleteness(ctx, ref) });
		}
		await refreshBriefTop(ctx, ref.id, { latest: null });
	},
};
