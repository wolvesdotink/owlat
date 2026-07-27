/**
 * THE RAMP AUDIT TRAIL (plan D12).
 *
 * One `mixDecisions` row for EVERY evaluation, INCLUDING THE NO-OPS. A row only
 * on change would answer "what moved" but never "was the controller even
 * looking", which is the question an operator actually has when a share has sat
 * still for a week. The KPI is that 100% of decisions carry a recorded,
 * human-readable reason, so `message` is a required field, not an optional one.
 *
 * Every DECREASE additionally carries `adminNotice`: the gate that broke and
 * what to do about it. A controller that silently retreats will be experienced
 * as a bug.
 */

import { v } from 'convex/values';
import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { internalMutation, type MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { adminQuery } from '../../lib/authedFunctions';
import type { RampControllerInput, RampDecision } from './controllerTypes';
import { describeRampDecision } from './controllerNarrative';

/** Decisions age out with the experiment record they explain (plan D16). */
export const MIX_DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 200;
const READ_LIMIT = 200;

/**
 * The gate inputs behind ONE decision, as a JSON blob. Evidence, never a query
 * predicate — so it is stored as a string rather than a nested object, and a
 * decision can be replayed against the pure function that made it.
 */
export function rampDecisionSnapshot(input: RampControllerInput, decision: RampDecision): string {
	return JSON.stringify({
		cell: deliverabilityCellKey(input.cell),
		now: Number.isFinite(input.now) ? input.now : null,
		isKillSwitchEngaged: input.isKillSwitchEngaged,
		signals: input.signals,
		capacity: input.capacity,
		mix: input.mix,
		config: {
			stream: input.config.stream,
			increaseStep: input.config.increaseStep,
			cleanWindowsRequired: input.config.cleanWindowsRequired,
		},
		evaluation:
			input.evaluation === null
				? null
				: {
						verdict: input.evaluation.verdict,
						failedGate: input.evaluation.failedGate ?? null,
						requiresCorroboration: input.evaluation.requiresCorroboration,
						cleanStreak: input.evaluation.cleanStreak,
						evaluatedAt: input.evaluation.evaluatedAt,
						perGate: input.evaluation.perGate,
					},
		outcome: {
			share: decision.share,
			reason: decision.reason,
			direction: decision.direction,
			ceiling: decision.ceiling,
		},
	});
}

/**
 * Record one evaluation. Called for every cell on every tick — the no-op rows
 * are the point, not overhead to be optimised away.
 */
export async function recordMixDecision(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		input: RampControllerInput;
		decision: RampDecision;
		at: number;
	}
): Promise<void> {
	const { organizationId, cell, input, decision, at } = args;
	const message = describeRampDecision(cell, decision);
	await ctx.db.insert('mixDecisions', {
		organizationId,
		cell: deliverabilityCellKey(cell),
		stream: cell.stream,
		destinationProvider: cell.destinationProvider,
		at,
		fromShare: decision.fromShare,
		toShare: decision.share,
		direction: decision.direction,
		verdict: decision.verdict,
		reason: decision.reason,
		message,
		...(decision.failedGate === undefined ? {} : { failedGate: decision.failedGate }),
		// The notice IS the message for a retreat: it already names the gate and
		// the remedy, so a second wording could only drift from the first.
		...(decision.direction === 'decrease' ? { adminNotice: message } : {}),
		...(decision.frozenUntil === undefined ? {} : { frozenUntil: decision.frozenUntil }),
		snapshot: rampDecisionSnapshot(input, decision),
		expiresAt: at + MIX_DECISION_RETENTION_MS,
	});
}

/**
 * Recent decisions for the delivery dashboard and for support. Admin-gated:
 * the snapshot blob carries whole-cell sending statistics.
 */
export const listRecentDecisions = adminQuery({
	args: { cell: v.optional(v.string()), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const requested = args.limit ?? 50;
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(READ_LIMIT, Math.floor(requested)))
			: 50;
		const cell = args.cell;
		if (cell === undefined) {
			// `expiresAt` is `at` plus one constant retention horizon, so ordering by
			// it IS ordering by decision time — no second index for the same order.
			return await ctx.db
				.query('mixDecisions')
				.withIndex('by_expires_at')
				.order('desc')
				.take(limit);
		}
		return await ctx.db
			.query('mixDecisions')
			.withIndex('by_cell_time', (q) => q.eq('cell', cell))
			.order('desc')
			.take(limit);
	},
});

/** Age out decisions past the retention horizon, in bounded batches. */
export const cleanupExpiredDecisions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query('mixDecisions')
			.withIndex('by_expires_at', (q) => q.lt('expiresAt', now))
			.take(CLEANUP_BATCH_SIZE);
		for (const row of expired) await ctx.db.delete(row._id);
		if (expired.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				1_000,
				internal.delivery.ramp.mixDecisions.cleanupExpiredDecisions,
				{}
			);
		}
		return { deleted: expired.length };
	},
});
