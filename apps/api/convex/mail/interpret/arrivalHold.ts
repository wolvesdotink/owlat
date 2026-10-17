/**
 * Read on arrival (SPEC §2.6, Sol r1 F13, r2 F4): every spend refusal of a
 * display-only arrival read is settled in the transaction that sees it.
 *
 *   - {@link reserveArrivalRun}: the run's one hold (a full read) or the
 *     gist's one-call hold, reserved in a mutation that settles the refusal
 *     itself.
 *   - {@link gateOrCount}: the full read's spend gate, asked in a mutation
 *     that counts the source when it refuses on budget.
 * When
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
import { noteArrivalRun } from '../arrival/records';
import { loadInterpretSource } from './sources';
import { interpretModeValidator } from '../../lib/validators/threadBrief';
import { interpretGate, type InterpretGateVerdict } from './gate';
import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
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
		if (!verdict.isAdmitted) await countRefused(ctx, args);
		return verdict;
	},
});

/** Count the refused source, when the refusing run still holds it in the loaded epoch. */
async function countRefused(
	ctx: MutationCtx,
	args: {
		source: { kind: 'mail'; id: Id<'mailMessages'> };
		leaseToken?: string;
		deletionEpoch: number;
	}
): Promise<boolean> {
	const row = await loadInterpretSource(ctx, args.source);
	const message = await ctx.db.get(args.source.id);
	if (!row || !message) return false;
	if ((await leaseLostAt(ctx, args.source, args.leaseToken)) !== null) return false;
	if (!(await isSettlementCurrent(ctx, message, args.deletionEpoch))) return false;
	const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.budget });
	await settleArrivalSkip(ctx, row, message._id, choice, 'budget');
	return true;
}

/** The spend gate of a display-only full read; a budget refusal counts it here. */
export const gateOrCount = internalMutation({
	args: {
		source: v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
		leaseToken: v.optional(v.string()),
		deletionEpoch: v.number(),
		mode: interpretModeValidator,
	},
	handler: async (ctx, args): Promise<{ verdict: InterpretGateVerdict; isCounted: boolean }> => {
		const verdict = await interpretGate(ctx, args.mode);
		const isCounted =
			!verdict.isAllowed && verdict.code === 'budget' ? await countRefused(ctx, args) : false;
		return { verdict, isCounted };
	},
});

/**
 * A full read of a live arrival that the depth decision did not count (an
 * upgrade, a predecessor read, an open) is about to call the model: its
 * record counts the call (Sol r3 F2), whatever admission charged. Called once
 * the run's hold is admitted, so a replayed extraction (the dedupe) counts
 * nothing.
 */
export const noteFullReadCall = internalMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<void> => {
		await noteArrivalRun(ctx, args.messageId, { depth: 'full', modelCalls: 1 });
	},
});
