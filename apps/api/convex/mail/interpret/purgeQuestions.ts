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
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { refreshBriefTop } from './briefTop';
import { EMPTY_SOURCE_COUNTS, shiftCount, sourceBucketOf } from './counters';
import { recomputeCompleteness } from './purgeRows';
import {
	scanRange,
	type DrainBudget,
	type JobState,
	type PurgeJob,
	type PurgeRange,
} from './purgeDrain';

/** Newest messages examined for the thread's re-read. */
const RECHECK_SCAN = 20;
/** Ask sessions of one draft read at a time (one per owner). */
const SESSION_CHUNK = 64;
/** The machine reason on an extraction marked for a re-read after a purge. */
export const PURGE_RECHECK_CODE = 'purge_recheck';

/** A plan without its references to `gone` items, marked stale. Pure. */
export function stripPlan(
	plan: Pick<
		Doc<'draftResponsePlans'>,
		'itemRevisions' | 'stances' | 'ownerInputs' | 'coverage' | 'newPromises'
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
		budget.read(row);
		cache.set(id, row === null);
		return row === null;
	};
}

/** 7a. The Postbox thread's clarification questions. */
const mailClarificationRange: PurgeRange = async (ctx, { ref, state, budget }) => {
	if (ref.kind !== 'mail' || !state.isItemDeleted) return { isDone: true };
	const thread = await ctx.db.get(ref.id);
	budget.read(thread);
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
						? q.eq('threadId', ref.id).gte('_creationTime', from)
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

/** One target's ask sessions (one per owner), from `afterOwner`. */
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
				: q.eq('targetKey', targetKey).gte('ownerId', afterOwner)
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
						? q.eq('threadId', ref.id).gte('_creationTime', from)
						: q.eq('threadId', ref.id)
				)
				.take(n),
		(row) => row._creationTime,
		async (draft) => {
			const targetKey = answerAskTargetKey({ kind: 'mailDraft', draftId: draft._id });
			let after: string | undefined;
			let atAfter = new Set<string>();
			for (;;) {
				if (budget.isExhausted()) return false;
				budget.range();
				const asked = SESSION_CHUNK + atAfter.size;
				const rows = await sessionsOf(ctx, targetKey, after, asked);
				for (const session of rows) {
					if (session.ownerId === after && atAfter.has(session._id)) continue;
					budget.read(session);
					await unlinkSession(ctx, session, isGone);
					if (session.ownerId === after) atAfter.add(session._id);
					else {
						after = session.ownerId;
						atAfter = new Set([session._id]);
					}
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
 * The newest surviving source of the thread with a complete current read and
 * an enqueue snapshot (`interpretSources`), or null. Never a source without a
 * snapshot: a re-read may not invent eligibility.
 */
async function recheckCandidate(
	ctx: MutationCtx,
	ref: ThreadRef
): Promise<{ source: InterpretationSource; counted: Doc<'messageInterpretations'> } | null> {
	const candidates: InterpretationSource[] = [];
	if (ref.kind === 'mail') {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_received', (q) => q.eq('threadId', ref.id))
			.order('desc')
			.take(RECHECK_SCAN);
		for (const m of messages) {
			candidates.push({ kind: 'mail', id: m._id }, { kind: 'outboundMail', id: m._id });
		}
	} else {
		const messages = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', ref.id))
			.order('desc')
			.take(RECHECK_SCAN);
		for (const m of messages) candidates.push({ kind: 'inbound', id: m._id });
	}
	for (const source of candidates) {
		const key = interpretationSourceKey(source);
		const counted = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_counted', (q) => q.eq('sourceKey', key).eq('isCounted', true))
			.first();
		if (!counted || counted.status !== 'complete' || !counted.payload) continue;
		const snapshot = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', key))
			.first();
		if (snapshot) return { source, counted };
	}
	return null;
}

/**
 * F3c: a claim survived on less evidence, so the thread is re-read. The
 * newest surviving source's counted read is marked `partial` (retry due now;
 * the source counters follow, so the brief reads incomplete and autonomy
 * holds) and its interpretation is scheduled: the reducer's re-run rebuilds
 * the thread from every current read and writes a new counted row. Without
 * a candidate the brief is still marked partial until the next
 * interpretation of the thread lands.
 */
async function recheckThread(ctx: MutationCtx, ref: ThreadRef): Promise<void> {
	const candidate = await recheckCandidate(ctx, ref);
	if (!candidate) return;
	const { counted, source } = candidate;
	const before = sourceBucketOf(counted);
	await ctx.db.patch(counted._id, {
		status: 'partial',
		errorCode: PURGE_RECHECK_CODE,
		nextRetryAt: Date.now(),
		updatedAt: Date.now(),
	});
	const brief = await loadBriefRow(ctx, ref);
	if (brief) {
		await ctx.db.patch(brief._id, {
			sourceCounts: shiftCount(brief.sourceCounts ?? EMPTY_SOURCE_COUNTS, before, 'partial'),
		});
	}
	await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, { source });
}

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
	if (state.isSurvivorChanged) await recheckThread(ctx, ref);
	const keys = new Set((job.sources ?? []).map(interpretationSourceKey));
	const isCheckpointGone = !!brief.checkpoint && keys.has(brief.checkpoint.sourceKey);
	const counted = await recomputeCompleteness(ctx, ref);
	const fresh = (await ctx.db.get(brief._id)) ?? brief;
	await ctx.db.patch(brief._id, {
		deletionEpoch: fresh.deletionEpoch + 1,
		interpretationRevision: fresh.interpretationRevision + 1,
		overview: undefined,
		completeness: state.isSurvivorChanged ? 'partial' : counted,
		...(isCheckpointGone ? { checkpoint: undefined } : {}),
		updatedAt: Date.now(),
	});
	if (ref.kind === 'mail') {
		await refreshBriefTop(ctx, ref.id, state.isInterpreted ? { latest: null } : {});
	}
}
