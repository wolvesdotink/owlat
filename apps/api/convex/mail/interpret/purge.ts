/**
 * Thread brief erasure, the message level (SPEC §5 "Erasure"): when a source
 * message is purged (Postbox "Delete forever", the trash auto-purge, an IMAP
 * EXPUNGE, a provider-side deletion pulled in by two-way sync, a contact's
 * erasure taking a Team Inbox message), everything the thread brief derived
 * from it goes or is recomputed. A `sources` purge job (`purgeDrain.ts`)
 * walks these ranges in order, resumably:
 *
 *  0. for a received Team Inbox message, every team reply that answered it
 *     (all of them, paged), added to the purged sources;
 *  1. its `messageInterpretations` rows (the sealed proposals and latest
 *     lines), taken out of the brief's source counters;
 *  2. its `interpretSources` snapshot (eligibility, a team reply's sent text);
 *  3. the activity rows naming it: the reducer's (`received:<source>`,
 *     `interp:<source>:…`), the send pipeline's (`sent:<id>`,
 *     `delivery_failed:<id>:…` …) and any whose `opRef` names it;
 *  4. its evidence on the thread's items, then 5. on its facts
 *     (`purgeClaims.ts`): "a surviving claim must keep surviving evidence".
 *     A claim left without any is deleted after its links (`purgeLinks.ts`);
 *     a survivor whose wording came from the purged message is restated
 *     from a surviving source or redacted;
 *  6. the thread's response plans lose their references to deleted items and
 *     go `stale`; 7. the surviving sources' claim records lose deleted
 *     items and facts; 8. the clarification questions (Postbox thread, Team Inbox
 *     messages) and 9. the Answer mode ask sessions lose their links to
 *     deleted items (`purgeQuestions.ts`).
 *
 * Settling (`purgeQuestions.ts settleSourcesJob`) bumps the brief's deletion
 * epoch and revision, drops the overview, recomputes completeness, clears a
 * checkpoint naming a purged source, refreshes `mailThreads.briefTop`, and
 * re-reads the thread when a claim survived on less evidence (F3c).
 */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { scopedIdempotencyKey } from './activity';
import { recordItemChange } from './counters';
import { deleteExtractions } from './purgeRows';
import { drainFactLinks, drainItemLinks } from './purgeLinks';
import { stripFact, stripItem, type PurgedSources } from './purgeClaims';
import {
	DRAIN_CHUNK,
	drainShrinking,
	drainSteps,
	scanRange,
	type JobPlan,
	type PurgeRange,
	type RangePosition,
	type RangeRun,
} from './purgeDrain';
import { clarificationAndRereadRanges, settleSourcesJob, stripPlan } from './purgeQuestions';

/**
 * Activity key families the send pipeline (`sendActivity.ts`) writes per
 * message or send id: `<family>:<id>` or `<family>:<id>:<detail>`.
 */
const SEND_EVENT_KEYS = ['sent', 'delivery_failed', 'send_queued', 'send_cancelled', 'send_held'];

/** The interpretation sources a purged Postbox message can be: received or sent. */
export function mailMessageSources(messageId: Id<'mailMessages'>): InterpretationSource[] {
	return [
		{ kind: 'mail', id: messageId },
		{ kind: 'outboundMail', id: messageId },
	];
}

/** The purged sources of a `sources` job, as its walk knows them so far. */
export function purgedOf(state: { sources: readonly InterpretationSource[] }): PurgedSources {
	return {
		ids: new Set(state.sources.map((s) => s.id as string)),
		keys: new Set(state.sources.map(interpretationSourceKey)),
	};
}

/** One sub-range per purged key or id: `drainSteps` keeps the first unfinished one. */
function stepsOf<T>(values: Iterable<T>, step: (value: T) => Promise<boolean>) {
	return [...values].map((value) => () => step(value));
}

/** Creation-time cursor: rows strictly after `after`. */
function afterTime(after: RangePosition | undefined): number | undefined {
	return typeof after === 'number' ? after : undefined;
}

const deleting =
	(ctx: MutationCtx) =>
	async (row: { _id: Id<'threadActivity' | 'interpretSources'> }): Promise<boolean> => {
		await ctx.db.delete(row._id);
		return true;
	};

/**
 * 0. A received Team Inbox message's team replies, all of them, paged by
 * creation time: each becomes a purged source before anything is erased.
 */
const repliesRange: PurgeRange = async (ctx, { job, cursor, budget, state }) => {
	const inboundMessageId = job.inboundMessageId;
	if (!inboundMessageId) return { isDone: true };
	return scanRange(
		budget,
		cursor,
		(after, n) => {
			const at = afterTime(after);
			return ctx.db
				.query('transactionalSends')
				.withIndex('by_inbound_message', (q) =>
					at === undefined
						? q.eq('inboundMessageId', inboundMessageId)
						: q.eq('inboundMessageId', inboundMessageId).gt('_creationTime', at)
				)
				.take(n);
		},
		(send) => send._creationTime,
		async (send) => {
			if (!state.sources.some((s) => s.kind === 'teamReply' && s.id === send._id)) {
				state.sources.push({ kind: 'teamReply', id: send._id });
			}
			return true;
		}
	);
};

/** A team reply source, added once. */
function addReply(state: { sources: InterpretationSource[] }, sendId: Id<'transactionalSends'>) {
	if (!state.sources.some((s) => s.kind === 'teamReply' && s.id === sendId)) {
		state.sources.push({ kind: 'teamReply', id: sendId });
	}
}

/**
 * 0b. The team follow-ups written in reply to the erased message
 * (`inboxFollowUps.inReplyToMessageId`): every Send of each (its `sendId`, and
 * every Send naming it by `followUpId`) becomes a purged source. Follow-ups
 * are walked by creation time (`at`), a follow-up's Sends likewise (`inner`).
 */
const followUpRepliesRange: PurgeRange = async (ctx, { job, ref, cursor, budget, state }) => {
	const inboundMessageId = job.inboundMessageId;
	if (!inboundMessageId || ref.kind !== 'team') return { isDone: true };
	let at = cursor?.at;
	let inner = cursor?.inner;
	const save = () => ({
		isDone: false as const,
		cursor: { ...(at !== undefined ? { at } : {}), ...(inner !== undefined ? { inner } : {}) },
	});
	for (;;) {
		if (budget.isExhausted()) return save();
		budget.range();
		const followUps = await ctx.db
			.query('inboxFollowUps')
			.withIndex('by_thread', (q) =>
				at === undefined
					? q.eq('threadId', ref.id)
					: q.eq('threadId', ref.id).gt('_creationTime', at)
			)
			.take(1);
		const followUp = followUps[0];
		if (!followUp) return { isDone: true };
		budget.charge(followUp);
		if (followUp.inReplyToMessageId === inboundMessageId) {
			if (followUp.sendId) addReply(state, followUp.sendId);
			for (;;) {
				if (budget.isExhausted()) return save();
				const asked = budget.chunk(DRAIN_CHUNK);
				budget.range();
				const sends = await ctx.db
					.query('transactionalSends')
					.withIndex('by_follow_up', (q) =>
						inner === undefined
							? q.eq('followUpId', followUp._id)
							: q.eq('followUpId', followUp._id).gt('_creationTime', inner)
					)
					.take(asked);
				for (const send of sends) {
					budget.charge(send);
					addReply(state, send._id);
					inner = send._creationTime;
					budget.progress();
				}
				if (sends.length < asked) break;
			}
		}
		at = followUp._creationTime;
		inner = undefined;
		budget.progress();
	}
};

/** 1. Every extraction of every purged source. */
const extractionsRange: PurgeRange = (ctx, { cursor, budget, state }) =>
	drainSteps(
		budget,
		cursor,
		stepsOf(purgedOf(state).keys, (key) =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('messageInterpretations')
						.withIndex('by_source_revision', (q) => q.eq('sourceKey', key))
						.take(n),
				async (row) => {
					state.isInterpreted = true;
					await deleteExtractions(ctx, [row]);
					return true;
				}
			)
		)
	);

/** 2. The purged sources' snapshots (and claim records). */
const snapshotsRange: PurgeRange = (ctx, { cursor, budget, state }) =>
	drainSteps(
		budget,
		cursor,
		stepsOf(purgedOf(state).keys, (key) =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('interpretSources')
						.withIndex('by_source_key', (q) => q.eq('sourceKey', key))
						.take(n),
				deleting(ctx)
			)
		)
	);

/** The activity key ranges `[from, to]` that name a purged source in this thread. */
function activityKeyRanges(ref: ThreadRef, purged: PurgedSources): Array<[string, string]> {
	const ranges: Array<[string, string]> = [];
	for (const key of purged.keys) {
		const received = scopedIdempotencyKey(ref, `received:${key}`);
		ranges.push([received, received]);
		const prefix = scopedIdempotencyKey(ref, `interp:${key}:`);
		ranges.push([prefix, `${prefix}\uffff`]);
	}
	for (const id of purged.ids) {
		for (const family of SEND_EVENT_KEYS) {
			const exact = scopedIdempotencyKey(ref, `${family}:${id}`);
			ranges.push([exact, `${exact}:\uffff`]);
		}
	}
	return ranges;
}

/** 3. The activity rows naming a purged source: by key, then by operation. */
const sourceActivityRange: PurgeRange = (ctx, { ref, cursor, budget, state }) => {
	const purged = purgedOf(state);
	return drainSteps(budget, cursor, [
		...stepsOf(activityKeyRanges(ref, purged), ([from, to]) =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadActivity')
						.withIndex('by_idempotency_key', (q) =>
							q.gte('idempotencyKey', from).lte('idempotencyKey', to)
						)
						.take(n),
				deleting(ctx)
			)
		),
		...stepsOf(purged.ids, (id) =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadActivity')
						.withIndex('by_op_ref', (q) => q.eq('opRef.id', id))
						.take(n),
				deleting(ctx)
			)
		),
	]);
};

/** A thread's items in creation order, strictly after `after`. */
export function itemsAfter(
	ctx: MutationCtx,
	ref: ThreadRef,
	after: RangePosition | undefined,
	n: number
) {
	const at = afterTime(after);
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', ref.id)
						: q.eq('mailThreadId', ref.id).gt('_creationTime', at)
				)
				.take(n)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread', (q) =>
					at === undefined
						? q.eq('conversationThreadId', ref.id)
						: q.eq('conversationThreadId', ref.id).gt('_creationTime', at)
				)
				.take(n);
}

/** 4. The thread's items: strip and rebuild, or clear the links and delete. */
const itemsRange: PurgeRange = (ctx, run: RangeRun) => {
	const purged = purgedOf(run.state);
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => itemsAfter(ctx, run.ref, after, n),
		(row) => row._creationTime,
		async (item) => {
			const fate = await stripItem(ctx, run.ref, item, purged, run.budget);
			if (fate === 'untouched') return true;
			run.state.isClaimChanged = true;
			if (fate === 'survived') {
				run.state.isSurvivorChanged = true;
				return true;
			}
			if (!(await drainItemLinks(ctx, run.ref, item, run.budget, { isThreadGone: false }))) {
				return false;
			}
			await recordItemChange(ctx, run.ref, item, null);
			await ctx.db.delete(item._id);
			run.state.isItemDeleted = true;
			return true;
		}
	);
};

/** 5. The thread's facts (mail threads only). */
const factsRange: PurgeRange = async (ctx, run) => {
	if (run.ref.kind !== 'mail') return { isDone: true };
	const threadId = run.ref.id;
	const purged = purgedOf(run.state);
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => {
			const at = afterTime(after);
			return ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', threadId)
						: q.eq('mailThreadId', threadId).gt('_creationTime', at)
				)
				.take(n);
		},
		(row) => row._creationTime,
		async (fact) => {
			const fate = await stripFact(ctx, fact, purged);
			if (fate === 'untouched') return true;
			run.state.isClaimChanged = true;
			if (fate === 'survived') {
				run.state.isSurvivorChanged = true;
				return true;
			}
			if (!(await drainFactLinks(ctx, fact, run.budget, { isThreadGone: false }))) return false;
			await ctx.db.delete(fact._id);
			return true;
		}
	);
};

/** 6. The thread's response plans: deleted items out, every plan stale. */
const plansRange: PurgeRange = async (ctx, run) => {
	if (!run.state.isClaimChanged) return { isDone: true };
	const ref = run.ref;
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => {
			const at = afterTime(after);
			return ref.kind === 'mail'
				? ctx.db
						.query('draftResponsePlans')
						.withIndex('by_mail_thread', (q) =>
							at === undefined
								? q.eq('mailThreadId', ref.id)
								: q.eq('mailThreadId', ref.id).gt('_creationTime', at)
						)
						.take(n)
				: ctx.db
						.query('draftResponsePlans')
						.withIndex('by_conversation_thread', (q) =>
							at === undefined
								? q.eq('conversationThreadId', ref.id)
								: q.eq('conversationThreadId', ref.id).gt('_creationTime', at)
						)
						.take(n);
		},
		(row) => row._creationTime,
		async (plan) => {
			const gone = new Set<string>();
			const ids = new Set<Id<'threadItems'>>();
			for (const entry of [...plan.itemRevisions, ...plan.stances, ...plan.coverage]) {
				ids.add(entry.itemId);
			}
			for (const input of plan.ownerInputs) if (input.itemId) ids.add(input.itemId);
			for (const id of ids) {
				const row = await ctx.db.get(id);
				run.budget.charge(row);
				if (!row) gone.add(id);
			}
			await ctx.db.patch(plan._id, stripPlan(plan, gone));
			return true;
		}
	);
};

/**
 * 7. The surviving sources' claim records (`interpretSources.claimIds`) lose
 * their entries for deleted items and facts.
 */
const claimRecordsRange: PurgeRange = async (ctx, run) => {
	if (!run.state.isClaimChanged) return { isDone: true };
	const ref = run.ref;
	const gone = new Map<string, boolean>();
	const isGone = async (id: Id<'threadItems'> | Id<'threadFacts'>) => {
		const known = gone.get(id);
		if (known !== undefined) return known;
		const row = await ctx.db.get(id);
		run.budget.charge(row);
		gone.set(id, row === null);
		return row === null;
	};
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => {
			const at = afterTime(after);
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
		async (record) => {
			if (!record.claimIds?.length) return true;
			const kept = [];
			for (const entry of record.claimIds) {
				const id = entry.itemId ?? entry.factId;
				if (!id || !(await isGone(id))) kept.push(entry);
			}
			if (kept.length !== record.claimIds.length) {
				await ctx.db.patch(record._id, { claimIds: kept, updatedAt: Date.now() });
			}
			return true;
		}
	);
};

/** The walk of a `sources` job. */
export const sourcesPlan: JobPlan = {
	ranges: [
		repliesRange,
		followUpRepliesRange,
		extractionsRange,
		snapshotsRange,
		sourceActivityRange,
		itemsRange,
		factsRange,
		plansRange,
		claimRecordsRange,
		...clarificationAndRereadRanges,
	],
	settle: settleSourcesJob,
};
