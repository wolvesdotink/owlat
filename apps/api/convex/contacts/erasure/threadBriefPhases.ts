/**
 * Thread brief erasure inside the contact and member erasure walkers (SPEC §5
 * "Erasure"; relations in `threadBriefRelations.ts` here and in
 * `auth/erasure/threadBriefRelations.ts`).
 *
 * The walkers drive the same resumable purge jobs the inline purge paths
 * schedule (`mail/interpret/purgeRun.ts drivePurgeJob`), inside their own
 * per-transaction budget: a job is keyed by what it erases, found again in
 * the walker's next transaction and continued where it stopped, never
 * scheduled. The parent row (thread, message) is only deleted once its job
 * finished.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { threadRefKey } from '../../lib/validators/threadRef';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { DrainBudget } from '../../mail/interpret/purgeDrain';
import { drivePurgeJob } from '../../mail/interpret/purgeRun';
import type { ErasureBudget } from './budget';
import { drainEach } from './phaseKit';

/**
 * Team replies to one received message whose interpretation goes with it: a
 * message is answered by a handful of sends (one per reply attempt).
 */
const REPLY_SOURCE_LIMIT = 64;
/**
 * Index ranges one row of budget stands for. The walkers bound a transaction
 * by rows and bytes; an empty range read costs neither, but the platform caps
 * a transaction at 4,096 ranges.
 */
const RANGES_PER_ROW = 4;

/** The walker's budget as a purge job's: every document a row, every 4 range queries one more. */
export function walkerDrainBudget(budget: ErasureBudget): DrainBudget {
	let ranges = 0;
	return {
		isExhausted: () => budget.isExhausted,
		read: (doc) => {
			if (doc) budget.charge(doc);
		},
		range: () => {
			ranges += 1;
			if (ranges % RANGES_PER_ROW === 0) budget.chargeRows(1);
		},
	};
}

/**
 * Delete every thread brief row of a thread being erased, within `budget`
 * (a `thread` purge job). Returns whether it finished; call it before
 * deleting the thread row.
 */
export function drainThreadBrief(
	ctx: MutationCtx,
	budget: ErasureBudget,
	ref: ThreadRef
): Promise<boolean> {
	return drivePurgeJob(
		ctx,
		`erasure:thread:${threadRefKey(ref)}`,
		{ ref, kind: 'thread' },
		walkerDrainBudget(budget)
	);
}

/**
 * Before a received Team Inbox message is erased: remove what its thread's
 * brief derived from it and from the team replies that answered it (a
 * `sources` purge job: extractions, evidence, claims left without evidence,
 * activity, links), and the response plans of the draft it carried.
 */
export async function eraseInboundMessageBrief(
	ctx: MutationCtx,
	budget: ErasureBudget,
	message: Doc<'inboundMessages'>
): Promise<boolean> {
	const isPlansEmpty = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('draftResponsePlans')
				.withIndex('by_inbound_draft', (q) => q.eq('inboundMessageId', message._id))
				.take(n),
		(plan) => ctx.db.delete(plan._id)
	);
	if (!isPlansEmpty) return false;
	if (!message.threadId) return true;
	const replies = await ctx.db
		.query('transactionalSends')
		.withIndex('by_inbound_message_status', (q) => q.eq('inboundMessageId', message._id))
		.take(REPLY_SOURCE_LIMIT);
	for (const reply of replies) budget.chargeRead(reply);
	const sources: InterpretationSource[] = [
		{ kind: 'inbound', id: message._id },
		...replies.map((reply) => ({ kind: 'teamReply' as const, id: reply._id })),
	];
	return drivePurgeJob(
		ctx,
		`erasure:inbound:${message._id}`,
		{ ref: { kind: 'team', id: message.threadId }, kind: 'sources', sources },
		walkerDrainBudget(budget)
	);
}

/** The response plans of one Postbox draft, before the draft goes. */
export function eraseDraftPlans(
	ctx: MutationCtx,
	budget: ErasureBudget,
	draftId: Id<'mailDrafts'>
): Promise<boolean> {
	return drainEach(
		budget,
		(n) =>
			ctx.db
				.query('draftResponsePlans')
				.withIndex('by_mail_draft', (q) => q.eq('mailDraftId', draftId))
				.take(n),
		(plan) => ctx.db.delete(plan._id)
	);
}
