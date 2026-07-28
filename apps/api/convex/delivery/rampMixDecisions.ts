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
 * A decision with a NAMED CAUSE — a breached gate or a hard stop — that also
 * CHANGED something additionally carries `adminNotice`: what broke and what to
 * do about it. "Changed something" is not the same as "moved the share": a
 * breach on a cell already at the soft floor holds the number while imposing a
 * fresh freeze and another rung of the cooldown ladder, and that is an incident.
 * A controller that silently retreats will be experienced as a bug; equally, an
 * alarm that cannot name a cause (a ceiling pulling a healthy cell back to its
 * rung) — or that re-announces the same unchanged hard stop every hour — is
 * noise that teaches operators to ignore the channel. See
 * `rampDecisionAdminNotice` for the exact predicate and why it is exact.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { RampControllerInput, RampDecision } from './ramp/controllerTypes';
import type { PaceDecision, PaceUtilisationReading } from './ramp/paceTypes';
import {
	describeRampDecision,
	paceDecisionAdminNotice,
	rampDecisionAdminNotice,
} from './ramp/controllerNarrative';

/** Decisions age out with the experiment record they explain (plan D16). */
const MIX_DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 200;

/**
 * The gate inputs behind ONE decision, as a JSON blob. Evidence, never a query
 * predicate — so it is stored as a string rather than a nested object, and a
 * decision can be replayed against the pure function that made it.
 */
function rampDecisionSnapshot(
	input: RampControllerInput,
	decision: RampDecision,
	pace: RecordedPaceDecision | undefined
): string {
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
		// THE SUBSTITUTION TABLE'S CONTRIBUTION, recorded alongside the constants it
		// produced. Without it a `degradation_ceiling` row states a cap and cannot
		// say which integration produced it — and the KPI is that 100% of decisions
		// carry a reason a human can act on (plan D12).
		degradation: {
			phaseCeilingCap: input.phaseCeilingCap,
			absent: input.absentIntegrations,
			ceilingCappedBy: input.ceilingCapSource ?? null,
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
		// The PIN belongs in the decision table, not only in `auditLogs`: `graduated`
		// is the steady state of a pinned cell, so without `pinChange` the tick that
		// awarded the pin is indistinguishable from the hundreds of identical rows
		// after it, and this is the table the delivery dashboard reads.
		outcome: {
			share: decision.share,
			reason: decision.reason,
			direction: decision.direction,
			ceiling: decision.ceiling,
			pinChange: decision.pinChange ?? null,
			graduatedAt: decision.graduatedAt ?? null,
		},
		// The SECOND actuator's evidence and outcome, in the same blob as the
		// first: the two decisions were made in one tick against one set of gates,
		// and a replay that could only reconstruct one of them would not be a
		// replay of what the controller did.
		pace:
			pace === undefined
				? null
				: {
						utilisation: pace.utilisation,
						fromMultiplier: pace.decision.fromMultiplier,
						multiplier: pace.decision.multiplier,
						reason: pace.decision.reason,
						direction: pace.decision.direction,
						cleanStreak: pace.decision.cleanStreak,
						countedUtcDay: pace.decision.countedUtcDay ?? null,
						isDeferred: pace.isDeferred,
					},
	});
}

/**
 * The pace half of one evaluation, as the audit row records it: the decision,
 * the evidence it was made against, and whether the composition interlock held
 * it back (plan D3, D12).
 */
export interface RecordedPaceDecision {
	readonly decision: PaceDecision;
	readonly utilisation: PaceUtilisationReading;
	readonly isDeferred: boolean;
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
		/** The pace actuator's half, absent on a cell with no pace state. */
		pace?: RecordedPaceDecision | undefined;
		at: number;
	}
): Promise<void> {
	const { organizationId, cell, input, decision, pace, at } = args;
	const message = describeRampDecision(cell, decision);
	// THE NOTICE COVERS BOTH DIALS (plan D12). A PACE-ONLY RETREAT IS REACHABLE:
	// the two actuators keep separate freeze columns by design, so a share still
	// inside an earlier gate cooldown returns `frozen` — a hold, and not
	// notifiable — while the pace dial, whose own freeze has expired, halves and
	// freezes on the same breach. Deriving the notice from the share alone would
	// write that incident to the audit row and tell nobody, and "every DECREASE
	// emits an admin notification naming the gate that broke" would be false for
	// the reputation-bearing half of the controller.
	//
	// When BOTH dials have something to say the two sentences are joined rather
	// than one being dropped: they are one tick's decision about one cell, and an
	// operator reading "the share halved" without "and so did the warming pace"
	// has half the incident.
	const notices = [
		rampDecisionAdminNotice(cell, decision),
		pace === undefined ? undefined : paceDecisionAdminNotice(cell, pace.decision),
	].filter((notice): notice is string => notice !== undefined);
	const adminNotice = notices.length === 0 ? undefined : notices.join(' ');
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
		// See the module header and `rampDecisionAdminNotice` for the predicate.
		// `noticeAt` mirrors `at` on exactly the rows that carry a notice — the
		// partial index Convex will not give us, expressed as a column.
		...(adminNotice === undefined ? {} : { adminNotice, noticeAt: at }),
		...(decision.freeze === undefined ? {} : { frozenUntil: decision.freeze.until }),
		...(pace === undefined
			? {}
			: {
					fromPaceMultiplier: pace.decision.fromMultiplier,
					toPaceMultiplier: pace.decision.multiplier,
					paceDirection: pace.decision.direction,
					paceReason: pace.decision.reason,
					isPaceDeferred: pace.isDeferred,
				}),
		snapshot: rampDecisionSnapshot(input, decision, pace),
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
