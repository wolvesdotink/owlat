/**
 * Thread brief erasure inside the contact and member erasure walkers (SPEC §5
 * "Erasure"; relations in `threadBriefRelations.ts` here and in
 * `auth/erasure/threadBriefRelations.ts`).
 *
 * The rows themselves are deleted by `mail/interpret/purgeRows.ts`, which the
 * inline purge paths use too; here they are drained within the walker's
 * per-transaction budget, so a thread with a long brief history is erased
 * over several transactions like any other parent.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import {
	bumpDeletionEpoch,
	deleteThreadBriefRow,
	threadBriefRanges,
} from '../../mail/interpret/purgeRows';
import { purgeSourcesFromThread } from '../../mail/interpret/purge';
import type { ErasureBudget } from './budget';
import { drainEach } from './phaseKit';

/** Team replies to one received message whose interpretation goes with it. */
const REPLY_SOURCE_LIMIT = 32;
/**
 * Index ranges one row of budget stands for. The walkers bound a transaction
 * by rows and bytes; an empty range read costs neither, but the platform caps
 * a transaction at 4,096 ranges, and a phase walking hundreds of threads reads
 * eight brief ranges for each even when none holds a row.
 */
const RANGES_PER_ROW = 4;
/**
 * Rows charged per message source purge for its index ranges (extractions,
 * activity keys, op refs, items, plans, brief row, list projection).
 */
const SOURCE_PURGE_ROWS = 5;

/**
 * Delete every thread brief row of a thread being erased, within `budget`:
 * the deletion epoch is bumped first (an in-flight interpretation gets
 * `erased`), the brief row that holds it goes last. Returns whether the
 * thread has none left; call it before deleting the thread row.
 */
export async function drainThreadBrief(
	ctx: MutationCtx,
	budget: ErasureBudget,
	ref: ThreadRef
): Promise<boolean> {
	const meter = (doc: unknown) => budget.chargeRead(doc);
	await bumpDeletionEpoch(ctx, ref, meter);
	let ranges = 1;
	try {
		for (const read of threadBriefRanges(ctx, ref)) {
			const counted = (n: number) => {
				ranges += 1;
				return read(n);
			};
			const isEmpty = await drainEach(budget, counted, (row) =>
				deleteThreadBriefRow(ctx, row, meter)
			);
			if (!isEmpty) return false;
		}
		return true;
	} finally {
		budget.chargeRows(Math.ceil(ranges / RANGES_PER_ROW));
	}
}

/**
 * Before a received Team Inbox message is erased: remove what its thread's
 * brief derived from it and from the team replies that answered it (their
 * extractions, the evidence they alone held, the activity naming them), and
 * the response plans of the draft it carried.
 */
export async function eraseInboundMessageBrief(
	ctx: MutationCtx,
	budget: ErasureBudget,
	message: Doc<'inboundMessages'>
): Promise<boolean> {
	const meter = (doc: unknown) => budget.chargeRead(doc);
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
	for (const reply of replies) meter(reply);
	const sources: InterpretationSource[] = [
		{ kind: 'inbound', id: message._id },
		...replies.map((reply) => ({ kind: 'teamReply' as const, id: reply._id })),
	];
	await purgeSourcesFromThread(ctx, { kind: 'team', id: message.threadId }, sources, meter);
	budget.chargeRows(SOURCE_PURGE_ROWS);
	return true;
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
