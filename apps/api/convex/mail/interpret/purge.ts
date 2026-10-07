/**
 * Thread brief erasure, the message level (SPEC §5 "Erasure"): when a source
 * message is purged (Postbox "Delete forever", the trash auto-purge, an IMAP
 * EXPUNGE, a provider-side deletion pulled in by two-way sync, a contact's
 * erasure taking a Team Inbox message), everything the thread brief derived
 * from it goes or is recomputed. A `sources` purge job (`purgeDrain.ts`)
 * walks these ranges in order, resumably:
 *
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
 *     go `stale`; 7. the clarification questions (Postbox thread, Team Inbox
 *     messages) and 8. the Answer mode ask sessions lose their links to
 *     deleted items (`purgeQuestions.ts`).
 *
 * Settling (`purgeQuestions.ts settleSourcesJob`) bumps the brief's deletion
 * epoch and revision, drops the overview, recomputes completeness, clears a
 * checkpoint naming a purged source, refreshes `mailThreads.briefTop`, and
 * re-reads the thread when a claim survived on less evidence (F3c).
 */

import type { Doc, Id } from '../../_generated/dataModel';
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
	drainShrinking,
	scanRange,
	type JobPlan,
	type PurgeRange,
	type RangePosition,
	type RangeRun,
} from './purgeDrain';
import { clarificationRanges, settleSourcesJob, stripPlan } from './purgeQuestions';

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

/** The purged sources of a `sources` job. */
export function purgedOf(job: Doc<'threadPurgeJobs'>): PurgedSources {
	const sources = job.sources ?? [];
	return {
		ids: new Set(sources.map((s) => s.id as string)),
		keys: new Set(sources.map(interpretationSourceKey)),
	};
}

const deleting =
	(ctx: MutationCtx) =>
	async (row: { _id: Id<'threadActivity' | 'interpretSources'> }): Promise<boolean> => {
		await ctx.db.delete(row._id);
		return true;
	};

/** 1. Every extraction of every purged source. */
const extractionsRange: PurgeRange = async (ctx, { job, budget, state }) => {
	for (const key of purgedOf(job).keys) {
		const isEmpty = await drainShrinking(
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
		);
		if (!isEmpty) return { isDone: false, cursor: undefined };
	}
	return { isDone: true };
};

/** 2. The purged sources' snapshots. */
const snapshotsRange: PurgeRange = async (ctx, { job, budget }) => {
	for (const key of purgedOf(job).keys) {
		const isEmpty = await drainShrinking(
			budget,
			(n) =>
				ctx.db
					.query('interpretSources')
					.withIndex('by_source_key', (q) => q.eq('sourceKey', key))
					.take(n),
			deleting(ctx)
		);
		if (!isEmpty) return { isDone: false, cursor: undefined };
	}
	return { isDone: true };
};

/** The activity key ranges `[from, to]` that name a purged source in this thread. */
function activityKeyRanges(ref: ThreadRef, job: Doc<'threadPurgeJobs'>): Array<[string, string]> {
	const purged = purgedOf(job);
	const ranges: Array<[string, string]> = [];
	for (const key of purged.keys) {
		const received = scopedIdempotencyKey(ref, `received:${key}`);
		ranges.push([received, received]);
		const prefix = scopedIdempotencyKey(ref, `interp:${key}:`);
		ranges.push([prefix, `${prefix}￿`]);
	}
	for (const id of purged.ids) {
		for (const family of SEND_EVENT_KEYS) {
			const exact = scopedIdempotencyKey(ref, `${family}:${id}`);
			ranges.push([exact, `${exact}:￿`]);
		}
	}
	return ranges;
}

/** 3. The activity rows naming a purged source. */
const sourceActivityRange: PurgeRange = async (ctx, { job, ref, budget }) => {
	for (const [from, to] of activityKeyRanges(ref, job)) {
		const isEmpty = await drainShrinking(
			budget,
			(n) =>
				ctx.db
					.query('threadActivity')
					.withIndex('by_idempotency_key', (q) =>
						q.gte('idempotencyKey', from).lte('idempotencyKey', to)
					)
					.take(n),
			deleting(ctx)
		);
		if (!isEmpty) return { isDone: false, cursor: undefined };
	}
	for (const id of purgedOf(job).ids) {
		const isEmpty = await drainShrinking(
			budget,
			(n) =>
				ctx.db
					.query('threadActivity')
					.withIndex('by_op_ref', (q) => q.eq('opRef.id', id))
					.take(n),
			deleting(ctx)
		);
		if (!isEmpty) return { isDone: false, cursor: undefined };
	}
	return { isDone: true };
};

/** A thread's items in creation order, from `from`. */
export function itemsFrom(
	ctx: MutationCtx,
	ref: ThreadRef,
	from: RangePosition | undefined,
	n: number
) {
	const at = typeof from === 'number' ? from : undefined;
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) =>
					at === undefined
						? q.eq('mailThreadId', ref.id)
						: q.eq('mailThreadId', ref.id).gte('_creationTime', at)
				)
				.take(n)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread', (q) =>
					at === undefined
						? q.eq('conversationThreadId', ref.id)
						: q.eq('conversationThreadId', ref.id).gte('_creationTime', at)
				)
				.take(n);
}

/** 4. The thread's items: strip, restate or redact, or clear the links and delete. */
const itemsRange: PurgeRange = (ctx, run: RangeRun) => {
	const purged = purgedOf(run.job);
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) => itemsFrom(ctx, run.ref, from, n),
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
	const purged = purgedOf(run.job);
	return scanRange(
		run.budget,
		run.cursor,
		(from, n) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread', (q) =>
					typeof from === 'number'
						? q.eq('mailThreadId', threadId).gte('_creationTime', from)
						: q.eq('mailThreadId', threadId)
				)
				.take(n),
		(row) => row._creationTime,
		async (fact) => {
			const fate = await stripFact(ctx, fact, purged, run.budget);
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
		(from, n) => {
			const at = typeof from === 'number' ? from : undefined;
			return ref.kind === 'mail'
				? ctx.db
						.query('draftResponsePlans')
						.withIndex('by_mail_thread', (q) =>
							at === undefined
								? q.eq('mailThreadId', ref.id)
								: q.eq('mailThreadId', ref.id).gte('_creationTime', at)
						)
						.take(n)
				: ctx.db
						.query('draftResponsePlans')
						.withIndex('by_conversation_thread', (q) =>
							at === undefined
								? q.eq('conversationThreadId', ref.id)
								: q.eq('conversationThreadId', ref.id).gte('_creationTime', at)
						)
						.take(n);
		},
		(row) => row._creationTime,
		async (plan) => {
			const gone = new Set<string>();
			for (const entry of [...plan.itemRevisions, ...plan.stances, ...plan.coverage]) {
				if (!(await ctx.db.get(entry.itemId))) gone.add(entry.itemId);
			}
			for (const input of plan.ownerInputs) {
				if (input.itemId && !(await ctx.db.get(input.itemId))) gone.add(input.itemId);
			}
			await ctx.db.patch(plan._id, stripPlan(plan, gone));
			return true;
		}
	);
};

/** The walk of a `sources` job. */
export const sourcesPlan: JobPlan = {
	ranges: [
		extractionsRange,
		snapshotsRange,
		sourceActivityRange,
		itemsRange,
		factsRange,
		plansRange,
		...clarificationRanges,
	],
	settle: settleSourcesJob,
};
