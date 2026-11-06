/**
 * Step 0 of a withdraw walk (`scopeReconcile.ts`): a thread fenced without
 * saying which message narrowed has every message paged for a current read
 * that no longer holds, and each one found joins the withdrawn reads. The
 * job's cursor carries the scan across slices, and no later range runs, the
 * fence lift included, before its last page.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { mailMessageSources } from './purge';
import {
	rowsAfterTied,
	scanRange,
	tiedPositionOf,
	withinCreationTime,
	type DrainBudget,
	type PurgeRange,
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

/** 0. The thread's messages, when the narrowed ones are not known (`isScanNeeded`). */
export const narrowedReadsRange: PurgeRange = async (ctx, run) => {
	if (!run.job.isScanNeeded || run.ref.kind !== 'mail') return { isDone: true };
	const threadId = run.ref.id;
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) =>
			rowsAfterTied(run.budget, after, n, (bound) =>
				ctx.db
					.query('mailMessages')
					.withIndex('by_thread', (q) => withinCreationTime(q.eq('threadId', threadId), bound))
			),
		tiedPositionOf,
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
