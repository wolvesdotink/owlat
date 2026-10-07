/**
 * The one write path for item changes made OUTSIDE the reducer (reactions,
 * the send-failure recompute). The reducer writes its own changes in
 * `reduceWrite.ts`; everything else patches an item through
 * {@link writeItemChange}, which keeps what the reducer keeps in the same
 * transaction:
 *
 *   - the brief's item counters (`counters.ts recordItemChange`), so counts
 *     stay right without a scan;
 *   - the list-row projection (`briefTop.ts refreshBriefTop`) of a mail thread.
 *
 * The caller appends the activity row itself, with `itemId`, provenance
 * `recorded` or `asserted` and the status / disposition `delta`, because an
 * ordered replay (`replay.ts applyHumanOps`) re-applies exactly those rows on
 * top of the rebuilt items.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { recordItemChange } from './counters';
import { refreshBriefTop } from './briefTop';

/** Patch one item and keep the counters and the list projection in step. */
export async function writeItemChange(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	patch: Partial<Doc<'threadItems'>>,
	opts: { isTopRefreshed?: boolean } = {}
): Promise<void> {
	await ctx.db.patch(item._id, patch);
	await recordItemChange(ctx, ref, item, {
		status: 'status' in patch && patch.status ? patch.status : item.status,
		responsibility:
			'responsibility' in patch && patch.responsibility
				? patch.responsibility
				: item.responsibility,
	});
	if ((opts.isTopRefreshed ?? true) && ref.kind === 'mail') await refreshBriefTop(ctx, ref.id);
}
