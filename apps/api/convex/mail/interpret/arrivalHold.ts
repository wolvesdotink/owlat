/**
 * Read on arrival (SPEC §2.6, Sol r1 F13): the spend hold of a display-only
 * full read, reserved in a mutation that settles the refusal itself. When
 * the run's one hold is refused, the source is settled as an upgradeable
 * `count` (`arrival.reason.budget`) in the same transaction that saw the
 * refusal, so no lost action in between can leave it for the stale sweep to
 * buy later. Bound to the run's lease, its deletion epoch and the mailbox
 * still being personal, like every arrival settlement.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import {
	reserveRunAllocations,
	reserveRunArgs,
	reserveRunReturns,
} from '../../aiRouting/admission';
import { leaseLostAt } from './lease';
import { loadInterpretSource } from './sources';
import {
	ARRIVAL_ADMISSION_REASONS,
	isSettlementCurrent,
	refusedCount,
	settleArrivalSkip,
} from './arrivalDecide';

export const reserveArrivalRun = internalMutation({
	args: {
		...reserveRunArgs,
		source: v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
		leaseToken: v.optional(v.string()),
		deletionEpoch: v.number(),
	},
	returns: reserveRunReturns,
	handler: async (ctx, args) => {
		const verdict = await reserveRunAllocations(ctx, args.allocations);
		if (verdict.isAdmitted) return verdict;
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!row || !message) return verdict;
		if ((await leaseLostAt(ctx, args.source, args.leaseToken)) !== null) return verdict;
		if (!(await isSettlementCurrent(ctx, message, args.deletionEpoch))) return verdict;
		const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.budget });
		await settleArrivalSkip(ctx, row, message._id, choice, 'budget');
		return verdict;
	},
});
