/**
 * THE ONLY WAY A PHASE CEILING RISES (plan D3, D12).
 *
 * A promotion moves the two things that matter most: it raises the rung the AIMD
 * ladder may climb to, and it re-randomises which arm EVERY recipient of the cell
 * lands in (plan D7's mix generation). So it is a deliberate act, never something
 * the hourly loop does on its own, and it is the ONE upward door — `resetCellPhase`
 * is downward-only precisely so that this gate cannot be walked around.
 *
 * ONE WRITE PATH, TWO ENTRIES. `applyRampPhasePromotion` is the whole rule; the
 * operator's `promoteCellPhase` and the machine-facing
 * `rampControllerCron.promoteRampPhase` both go through it. Two copies of a gate
 * are two gates, and the second one is always the one that drifts.
 *
 * THE HARD STOPS BOUND A PROMOTION TOO, through `readRampIncreaseBlock` — the
 * controller's own readers, not a second copy of the rules. The global kill
 * switch's contract is that nothing moves while it is engaged; abuse suspension,
 * an open breaker, a critical blocklist listing and a live cooldown are the same
 * conditions that stop the share climbing, and a rung is a bigger move than a
 * step.
 */

import {
	deliverabilityCellKey,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getMutationContext, getSingletonOrganizationId } from '../lib/sessionOrganization';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { nextPhaseCeiling, normalizePhaseCeiling } from './ramp/controllerConfig';
import { evaluatePhasePromotion, type PromotionConditionId } from './ramp/phasePromotion';
import { loadRampPromotionEvidence } from './rampPromotionEvidence';
import { loadCellDegradation } from './rampIntegrationPresence';
import { readRampIncreaseBlock } from './rampControllerInputs';
import { recordOperatorRampAction } from './rampControlAudit';
import type { RampControlRefusal } from './rampControls';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';

/**
 * What the promotion rule concluded. A discriminated union rather than a
 * nullable ceiling because the four outcomes are genuinely different answers:
 * the cell moved, it was already at the top, the evidence is short (and can be
 * named), or a hard stop stands.
 */
export type RampPhasePromotion =
	| {
			readonly status: 'promoted';
			readonly fromCeiling: number;
			readonly phaseCeiling: number;
			readonly share: number;
	  }
	| { readonly status: 'at_top'; readonly phaseCeiling: number; readonly share: number }
	| {
			readonly status: 'outstanding';
			readonly phaseCeiling: number;
			/** Every applicable route's unmet conditions, by name (plan D12/D14). */
			readonly outstanding: readonly PromotionConditionId[];
	  }
	| { readonly status: 'refused'; readonly refusal: RampControlRefusal };

/**
 * Promote one cell one rung, or say why not. Writes the row; writes no audit —
 * the caller owns that, because the machine entry and the operator entry do not
 * attribute a promotion to the same actor.
 *
 * The organization is a PARAMETER rather than a session read: the cron resolves
 * its tenant through `resolveRampOrganizationId` (a throw means "no organization
 * yet", a supported configuration) while the operator path takes it from the
 * session. One rule, two resolvers, no way for either to name someone else's row
 * — the index read behind `loadRouteStateCell` is org-leading.
 */
export async function applyRampPhasePromotion(
	ctx: MutationCtx,
	args: {
		readonly organizationId: string;
		readonly cell: DeliverabilityCell;
		readonly now: number;
	}
): Promise<RampPhasePromotion> {
	const { organizationId, cell, now } = args;
	const { perStream } = await loadRouteStateCell(ctx, organizationId, cell);
	// `ownShare === undefined` IS the definition of unmanaged, the same one
	// `rampControllerInputs` uses. A row without one belongs to no ramp: giving it
	// a phase ceiling would leave a ceiling on a cell the controller still ignores,
	// and the next enrolment would inherit a rung nobody earned.
	if (perStream === null || perStream.ownShare === undefined) {
		return { status: 'refused', refusal: 'cell_not_ramp_managed' };
	}
	const block = await readRampIncreaseBlock(ctx, { organizationId, cell, perStream, now });
	if (block !== null) return { status: 'refused', refusal: block };

	// One rung, through the ladder helper: an arbitrary caller-supplied ceiling
	// would let a promotion skip 0.5 and 0.8 straight to 1.0.
	//
	// BOTH SIDES OF THE COMPARISON COME OFF ONE READING. `phaseCeiling` is an
	// unconstrained optional number in the schema and `nextPhaseCeiling`
	// normalises internally, so comparing the RAW stored value against the
	// normalised next rung made a row carrying 1.2 answer `1 !== 1.2`: not at the
	// top, therefore "promoted" — patching the ceiling DOWN to 1.0 while writing
	// an audit row claiming a promotion to 100% and spending a mix generation on
	// it. A degenerate rung must fail closed like every other stored value here.
	const current = normalizePhaseCeiling(perStream.phaseCeiling);
	const phaseCeiling = nextPhaseCeiling(current);
	const share = resolveOwnShare(perStream);
	// Already at the top rung: nothing to promote, and re-randomising the cohort
	// for a no-op would cost the comparison its continuity for nothing.
	if (phaseCeiling === current) return { status: 'at_top', phaseCeiling, share };

	// CROSSING THE 0.5 CEILING IS EVIDENCE-GATED (plan D3), and the rule is a
	// table of ROUTES rather than a branch: either an external reading for this
	// cell within the last 7 days, or the four corroborating self-hosted
	// conditions. Below that line no route is consulted and the promotion is the
	// ordinary ladder step it has always been — so a deployment with no external
	// account is slowed, never stopped (plan D2).
	const degradation = await loadCellDegradation(ctx, { organizationId, cell, now });
	const promotion = evaluatePhasePromotion({
		targetCeiling: phaseCeiling,
		provider: cell.destinationProvider,
		evidence: await loadRampPromotionEvidence(ctx, {
			organizationId,
			cell,
			perStream,
			degradation,
			now,
		}),
		now,
	});
	if (!promotion.allowed) {
		// NOT AN ERROR AND NOT A FAILURE — the cell keeps ramping at its current
		// rung. The outstanding conditions travel back by name so the screen can
		// say what would unlock it (plan D12/D14).
		return {
			status: 'outstanding',
			phaseCeiling: current,
			outstanding: promotion.routes.flatMap((route) =>
				route.outstanding.map((entry) => entry.condition)
			),
		};
	}
	await ctx.db.patch(perStream._id, {
		phaseCeiling,
		// THE DWELL CLOCK STARTS HERE: the rung is what it measures, and this is
		// the only place a rung goes UP.
		phaseCeilingSince: now,
		mixVersion: (perStream.mixVersion ?? 0) + 1,
		// The ramp's own clock, never the router's freshness clock — see
		// `applyDecision`.
		decidedAt: now,
	});
	return { status: 'promoted', fromCeiling: current, phaseCeiling, share };
}

export interface RampPromotionResult {
	readonly applied: boolean;
	readonly refusal?: RampControlRefusal;
	/** The rung the cell stands on AFTER the call — unchanged on a refusal. */
	readonly phaseCeiling?: number;
	/** Named unmet conditions, present only with `promotion_evidence_outstanding`. */
	readonly outstanding?: readonly PromotionConditionId[];
}

/**
 * THE OPERATOR'S PROMOTION.
 *
 * A promotion does NOT move the share — it raises the bound the share may climb
 * to — so the `mixDecisions` row it writes records the same number on both sides
 * (plan D12 asks for every decision, not only the ones that moved a number). The
 * pair is written by the shared helper for the reason every other control uses
 * it: an action in the audit log with no decision row would leave the cell's
 * timeline showing an unexplained jump in its ceiling.
 */
export const promoteCellPhase = adminMutation({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
	},
	handler: async (ctx, args): Promise<RampPromotionResult> => {
		const { userId } = await getMutationContext(ctx);
		const organizationId = await getSingletonOrganizationId(ctx);
		const cell: DeliverabilityCell = {
			stream: args.stream,
			destinationProvider: args.destinationProvider,
		};
		const now = Date.now();
		const promotion = await applyRampPhasePromotion(ctx, { organizationId, cell, now });
		if (promotion.status === 'refused') {
			return { applied: false, refusal: promotion.refusal };
		}
		if (promotion.status === 'outstanding') {
			return {
				applied: false,
				refusal: 'promotion_evidence_outstanding',
				phaseCeiling: promotion.phaseCeiling,
				outstanding: promotion.outstanding,
			};
		}
		// The top rung is not a refusal and not a move: the operator asked for
		// something the cell already has.
		if (promotion.status === 'at_top') {
			return { applied: false, phaseCeiling: promotion.phaseCeiling };
		}
		await recordOperatorRampAction(ctx, {
			organizationId,
			userId,
			cell,
			action: 'deliverability_ramp.phase_promoted',
			reason: 'operator_phase_promotion',
			// A PROMOTION MOVES THE CEILING, NOT THE SHARE. Reporting a jump to the
			// new rung here would claim traffic moved that has not: the share still
			// has to earn every step up to it on the ordinary gates.
			fromShare: promotion.share,
			toShare: promotion.share,
			message: `An operator promoted ${deliverabilityCellKey(cell)} to the ${Math.round(promotion.phaseCeiling * 100)}% phase; the promotion evidence allowed it. The share stays at ${Math.round(promotion.share * 100)}% and climbs toward the new ceiling on the ordinary gates.`,
			detail: {
				phaseCeiling: promotion.phaseCeiling,
				fromPhaseCeiling: promotion.fromCeiling,
			},
			at: now,
		});
		return { applied: true, phaseCeiling: promotion.phaseCeiling };
	},
});
