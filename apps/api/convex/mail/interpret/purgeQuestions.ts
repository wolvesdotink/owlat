/**
 * The end of a `sources` purge job (`purge.ts`): the links into deleted
 * items from outside the thread brief tables (review round 1, F13), and the
 * brief's settle step with the thread's re-read (F3c).
 *
 *  - Postbox: the thread's `needsReply.clarification` questions;
 *  - Team Inbox: every message's `pendingClarification` questions;
 *  - Answer mode: the ask sessions on the team thread, or on the Postbox
 *    thread's drafts.
 *
 * A question keeps its text and loses only its `itemId` when that item is
 * gone. The walks are resumable (`purgeDrain.ts scanRange`): the rows stay.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { answerAskTargetKey } from '../../lib/validators/answerAsk';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import { briefCompleteness, isRepairMarked, markRepair } from './purgeRepairs';
import {
	scanRange,
	type DrainBudget,
	type JobState,
	type PurgeJob,
	type PurgeRange,
} from './purgeDrain';

/** Ask sessions of one draft read at a time (one per owner). */
const SESSION_CHUNK = 64;
/** The machine reason on an extraction marked for a re-read after a purge. */
export { PURGE_RECHECK_CODE } from './purgeRepairs';

/**
 * A plan without its references to `gone` items, marked stale, its revision
 * bumped so a check computed before the purge is never stored after it
 * (final review F3). Pure.
 */
export function stripPlan(
	plan: Pick<
		Doc<'draftResponsePlans'>,
		'itemRevisions' | 'stances' | 'ownerInputs' | 'coverage' | 'newPromises' | 'planRevision'
	>,
	gone: ReadonlySet<string>
) {
	const keep = (entry: { itemId: string }) => !gone.has(entry.itemId);
	return {
		itemRevisions: plan.itemRevisions.filter(keep),
		stances: plan.stances.filter(keep),
		ownerInputs: plan.ownerInputs.map((input) =>
			input.itemId && gone.has(input.itemId) ? { questionId: input.questionId } : input
		),
		coverage: plan.coverage.filter(keep),
		newPromises: plan.newPromises.map(({ itemId, ...promise }) =>
			itemId && !gone.has(itemId) ? { ...promise, itemId } : promise
		),
		verdict: 'stale' as const,
		planRevision: (plan.planRevision ?? 0) + 1,
		updatedAt: Date.now(),
	};
}

/**
 * Questions without their links to deleted items, or null when none links
 * one. `isGone` answers per item id (cached by the caller).
 */
async function unlinkQuestions<Q extends { itemId?: Id<'threadItems'> }>(
	questions: readonly Q[],
	isGone: (id: Id<'threadItems'>) => Promise<boolean>
): Promise<Q[] | null> {
	let isChanged = false;
	const next: Q[] = [];
	for (const question of questions) {
		if (question.itemId && (await isGone(question.itemId))) {
			const { itemId: _gone, ...rest } = question;
			next.push(rest as Q);
			isChanged = true;
		} else next.push(question);
	}
	return isChanged ? next : null;
}

function goneCheck(ctx: MutationCtx, budget: DrainBudget) {
	const cache = new Map<string, boolean>();
	return async (id: Id<'threadItems'>): Promise<boolean> => {
		const known = cache.get(id);
		if (known !== undefined) return known;
		const row = await ctx.db.get(id);
		budget.charge(row);
		cache.set(id, row === null);
		return row === null;
	};
}

/** 7a. The Postbox thread's clarification questions. */
const mailClarificationRange: PurgeRange = async (ctx, { ref, state, budget }) => {
	if (ref.kind !== 'mail' || !state.isItemDeleted) return { isDone: true };
	const thread = await ctx.db.get(ref.id);
	budget.charge(thread);
	const clarification = thread?.needsReply?.clarification;
	if (!thread?.needsReply || !clarification) return { isDone: true };
	const questions = await unlinkQuestions(clarification.questions, goneCheck(ctx, budget));
	if (questions) {
		await ctx.db.patch(thread._id, {
			needsReply: { ...thread.needsReply, clarification: { ...clarification, questions } },
		});
	}
	return { isDone: true };
};

/** 7b. The Team Inbox thread's messages' pending clarification questions. */
const teamClarificationRange: PurgeRange = async (ctx, run) => {
	const { ref, state, budget } = run;
	if (ref.kind !== 'team' || !state.isItemDeleted) return { isDone: true };
	const isGone = goneCheck(ctx, budget);
	return scanRange(
		budget,
		run.cursor,
		(from, n) =>
			ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) =>
					typeof from === 'number'
						? q.eq('threadId', ref.id).gt('_creationTime', from)
						: q.eq('threadId', ref.id)
				)
				.take(n),
		(row) => row._creationTime,
		async (message) => {
			const pending = message.pendingClarification;
			if (!pending) return true;
			const questions = await unlinkQuestions(pending.questions, isGone);
			if (questions)
				await ctx.db.patch(message._id, { pendingClarification: { ...pending, questions } });
			return true;
		}
	);
};

/** One target's ask sessions (one per owner), strictly after `afterOwner`. */
function sessionsOf(
	ctx: MutationCtx,
	targetKey: string,
	afterOwner: string | undefined,
	n: number
) {
	return ctx.db
		.query('answerAskSessions')
		.withIndex('by_target_owner', (q) =>
			afterOwner === undefined
				? q.eq('targetKey', targetKey)
				: q.eq('targetKey', targetKey).gt('ownerId', afterOwner)
		)
		.take(n);
}

async function unlinkSession(
	ctx: MutationCtx,
	session: Doc<'answerAskSessions'>,
	isGone: (id: Id<'threadItems'>) => Promise<boolean>
): Promise<void> {
	const questions = await unlinkQuestions(session.questions, isGone);
	if (questions) await ctx.db.patch(session._id, { questions, updatedAt: Date.now() });
}

/** 8. The Answer mode ask sessions on the thread (team) or its drafts (Postbox). */
const askSessionsRange: PurgeRange = async (ctx, run) => {
	const { ref, state, budget } = run;
	if (!state.isItemDeleted) return { isDone: true };
	const isGone = goneCheck(ctx, budget);
	if (ref.kind === 'team') {
		const targetKey = answerAskTargetKey({ kind: 'teamThread', threadId: ref.id });
		return scanRange(
			budget,
			run.cursor,
			(from, n) => sessionsOf(ctx, targetKey, typeof from === 'string' ? from : undefined, n),
			(row) => row.ownerId,
			async (session) => {
				await unlinkSession(ctx, session, isGone);
				return true;
			}
		);
	}
	// A draft's sessions are one per owner (its readers): handled whole, again
	// from its first one if a slice ends midway (unlinking twice is a no-op).
	return scanRange(
		budget,
		run.cursor,
		(from, n) =>
			ctx.db
				.query('mailDrafts')
				.withIndex('by_thread', (q) =>
					typeof from === 'number'
						? q.eq('threadId', ref.id).gt('_creationTime', from)
						: q.eq('threadId', ref.id)
				)
				.take(n),
		(row) => row._creationTime,
		async (draft) => {
			const targetKey = answerAskTargetKey({ kind: 'mailDraft', draftId: draft._id });
			let after: string | undefined;
			for (;;) {
				if (budget.isExhausted()) return false;
				const asked = budget.chunk(SESSION_CHUNK);
				budget.range();
				const rows = await sessionsOf(ctx, targetKey, after, asked);
				for (const session of rows) budget.charge(session);
				for (const session of rows) {
					await unlinkSession(ctx, session, isGone);
					after = session.ownerId;
				}
				if (rows.length < asked) return true;
			}
		}
	);
};

export const clarificationRanges: readonly PurgeRange[] = [
	mailClarificationRange,
	teamClarificationRange,
	askSessionsRange,
];

/**
 * Rule P (4): a claim lost evidence and was redacted, so the thread is
 * re-read from every surviving source that has an enqueue snapshot
 * (`interpretSources`; never one without: a re-read may not invent
 * eligibility). Each source whose counted read is complete is marked
 * `partial` (retry due now; the source counters follow, so the brief reads
 * incomplete and autonomy holds) and its interpretation is scheduled; the
 * monotone planner merges by lineage and refills the redacted fields. A
 * resumable range: every source costs budget, so a thread with many sources
 * is scheduled over as many slices as it takes.
 */
const reinterpretRange: PurgeRange = async (ctx, run) => {
	const { ref, state, budget } = run;
	if (!state.isSurvivorChanged) return { isDone: true };
	return scanRange(
		budget,
		run.cursor,
		(after, n) => {
			const at = typeof after === 'number' ? after : undefined;
			return ref.kind === 'mail'
				? ctx.db
						.query('interpretSources')
						.withIndex('by_mail_thread', (q) =>
							at === undefined
								? q.eq('mailThreadId', ref.id)
								: q.eq('mailThreadId', ref.id).gt('_creationTime', at)
						)
						.take(n)
				: ctx.db
						.query('interpretSources')
						.withIndex('by_conversation_thread', (q) =>
							at === undefined
								? q.eq('conversationThreadId', ref.id)
								: q.eq('conversationThreadId', ref.id).gt('_creationTime', at)
						)
						.take(n);
		},
		(row) => row._creationTime,
		async (snapshot) => {
			budget.range();
			const counted = await ctx.db
				.query('messageInterpretations')
				.withIndex('by_source_counted', (q) =>
					q.eq('sourceKey', snapshot.sourceKey).eq('isCounted', true)
				)
				.first();
			budget.charge(counted);
			if (!counted?.payload) return true;
			// A complete read is marked for repair; one an earlier purge marked
			// (still outstanding) is scheduled again, counted once.
			if (counted.status !== 'complete' && !isRepairMarked(counted)) return true;
			const brief = await loadBriefRow(ctx, ref);
			if (!brief) return true;
			await markRepair(ctx, brief, counted);
			await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
				source: snapshot.source,
			});
			return true;
		}
	);
};

export const clarificationAndRereadRanges: readonly PurgeRange[] = [
	...clarificationRanges,
	reinterpretRange,
];

/** Settle a `sources` job: the brief row and the list projection. */
export async function settleSourcesJob(
	ctx: MutationCtx,
	job: PurgeJob,
	ref: ThreadRef,
	state: JobState
): Promise<void> {
	const brief = await loadBriefRow(ctx, ref);
	if (!brief) {
		if (ref.kind === 'mail') {
			const thread = await ctx.db.get(ref.id);
			if (thread?.briefTop) await ctx.db.patch(ref.id, { briefTop: undefined });
		}
		return;
	}
	const keys = new Set(state.sources.map(interpretationSourceKey));
	const isCheckpointGone = !!brief.checkpoint && keys.has(brief.checkpoint.sourceKey);
	const fresh = (await ctx.db.get(brief._id)) ?? brief;
	// The epoch was bumped when the job started; bumping it again here would
	// turn the re-reads scheduled above (an earlier slice) into `erased`.
	await ctx.db.patch(brief._id, {
		interpretationRevision: fresh.interpretationRevision + 1,
		overview: undefined,
		// Derived like the reducer does (purgeRepairs.ts): partial while a
		// repair is outstanding, never forced (a repair may already have landed).
		completeness: briefCompleteness(fresh),
		...(isCheckpointGone ? { checkpoint: undefined } : {}),
		updatedAt: Date.now(),
	});
	if (ref.kind === 'mail') {
		await refreshBriefTop(ctx, ref.id, state.isInterpreted ? { latest: null } : {});
	}
}
