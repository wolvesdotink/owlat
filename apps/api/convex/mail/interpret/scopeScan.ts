/**
 * Step 0 of a withdraw walk (`scopeReconcile.ts`): a thread fenced without
 * saying which message narrowed has every message paged for a current read
 * that no longer holds, and each one found joins the withdrawn reads. The
 * job's cursor carries the scan across slices, and no later range runs, the
 * fence lift included, before its last page.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { mailMessageSources } from './purge';
import {
	scanRange,
	type DrainBudget,
	type PurgeRange,
	type RangePosition,
	type TiedPosition,
} from './purgeDrain';
import { sourceVersionOf } from './sourceVersion';

/**
 * Does a current read of the message predate what is stored now (its body
 * fingerprint moved, as a clearsigned scope gained later moves it)?
 */
async function isReadStale(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	budget?: DrainBudget
): Promise<boolean> {
	for (const source of mailMessageSources(message._id)) {
		budget?.range();
		const read = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_current', (q) =>
				q.eq('sourceKey', interpretationSourceKey(source)).eq('isCurrent', true)
			)
			.first();
		budget?.charge(read);
		if (!read?.payload) continue;
		if (read.sourceVersion !== (await sourceVersionOf(ctx, source))) return true;
	}
	return false;
}

/**
 * The thread's first `n` messages after `after`, in index order. Many
 * messages can share one creation time (an import batch, one millisecond), so
 * a position is the creation time with the message's id: the rest of that
 * creation time is read past the id, then every later one. The index orders
 * the rows of one creation time by id, and the ids of one table compare as
 * strings in that order (as `lib/keysetMerge.ts` relies on). The rows passed
 * over are charged, as every fetched row is.
 */
async function messagesAfter(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	after: RangePosition | undefined,
	n: number,
	budget: DrainBudget
): Promise<Doc<'mailMessages'>[]> {
	const messages = () => ctx.db.query('mailMessages');
	if (after === undefined) {
		return messages()
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.take(n);
	}
	// A position without an id (none is written) reads its whole creation time again.
	const { at, key } = typeof after === 'object' ? after : { at: Number(after), key: '' };
	const rows: Doc<'mailMessages'>[] = [];
	const tied = messages().withIndex('by_thread', (q) =>
		q.eq('threadId', threadId).eq('_creationTime', at)
	);
	for await (const message of tied) {
		if (message._id <= key) {
			budget.charge(message);
			continue;
		}
		rows.push(message);
		if (rows.length === n) return rows;
	}
	budget.range();
	const later = await messages()
		.withIndex('by_thread', (q) => q.eq('threadId', threadId).gt('_creationTime', at))
		.take(n - rows.length);
	return [...rows, ...later];
}

/** 0. The thread's messages, when the narrowed ones are not known (`isScanNeeded`). */
export const narrowedReadsRange: PurgeRange = async (ctx, run) => {
	if (!run.job.isScanNeeded || run.ref.kind !== 'mail') return { isDone: true };
	const threadId = run.ref.id;
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => messagesAfter(ctx, threadId, after, n, run.budget),
		(row): TiedPosition => ({ at: row._creationTime, key: row._id }),
		async (message) => {
			if (!message.inboundSignatureInfo?.scope) return true;
			if (!(await isReadStale(ctx, message, run.budget))) return true;
			const known = new Set(run.state.sources.map(interpretationSourceKey));
			for (const source of mailMessageSources(message._id)) {
				if (!known.has(interpretationSourceKey(source))) run.state.sources.push(source);
			}
			return true;
		}
	);
};
