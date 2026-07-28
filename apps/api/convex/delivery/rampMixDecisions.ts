/**
 * THE RAMP AUDIT TRAIL (plan D12).
 *
 * One `mixDecisions` row for EVERY evaluation, INCLUDING THE NO-OPS. A row only
 * on change would answer "what moved" but never "was the controller even
 * looking", which is the question an operator actually has when a share has sat
 * still for a week. The KPI is that 100% of decisions carry a recorded,
 * human-readable reason, so `message` is a required field, not an optional one.
 *
 * NO READ PATH SHIPS HERE. The delivery dashboard is a later piece and owns the
 * query it needs; a read function with no consumer is a seam with no
 * requirements behind it (plan D20), and the unscoped version this file used to
 * carry read a TENANT table without pinning the tenant. The index the dashboard
 * will read through — `by_org_cell_time` — is in the schema and is exercised by
 * `__tests__/mixDecisions.test.ts`.
 *
 * A retreat with a NAMED CAUSE — a breached gate or a hard stop — additionally
 * carries `adminNotice`: what broke and what to do about it. A controller that
 * silently retreats will be experienced as a bug; equally, an alarm that cannot
 * name a cause (a ceiling pulling a healthy cell back to its rung) is noise
 * that teaches operators to ignore the channel.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { RampControllerInput, RampDecision } from './ramp/controllerTypes';
import { describeRampDecision, rampDecisionAdminNotice } from './ramp/controllerNarrative';

/** Decisions age out with the experiment record they explain (plan D16). */
export const MIX_DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 200;

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
	const adminNotice = rampDecisionAdminNotice(cell, decision);
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
		// Present only on a retreat with a NAMED cause (a breached gate or a hard
		// stop) — see `rampDecisionAdminNotice`.
		...(adminNotice === undefined ? {} : { adminNotice }),
		...(decision.frozenUntil === undefined ? {} : { frozenUntil: decision.frozenUntil }),
		snapshot: rampDecisionSnapshot(input, decision),
		expiresAt: at + MIX_DECISION_RETENTION_MS,
	});
}

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
				internal.delivery.rampMixDecisions.cleanupExpiredDecisions,
				{}
			);
		}
		return { deleted: expired.length };
	},
});
