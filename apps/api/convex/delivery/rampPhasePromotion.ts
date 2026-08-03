/**
 * THE ONLY WAY A PHASE CEILING RISES (plan D3, D12).
 *
 * A promotion moves the two things that matter most: it raises the rung the AIMD
 * ladder may climb to, and — on the ESP path — it re-randomises which arm every
 * recipient of the cell lands in (plan D7's mix generation). The generation
 * advances on the PACE path too and re-shuffles nobody there, because that cell
 * has one arm; `rampPhaseReset` carries the rule for why only that one door holds
 * it back. So a promotion is a deliberate act, never something the hourly loop
 * does on its own, and it is the ONE upward door — `resetCellPhase` is
 * downward-only precisely so that this gate cannot be walked around.
 *
 * ONE WRITE PATH, ONE ENTRY. `applyRampPhasePromotion` is the whole rule and
 * `promoteCellPhase` is the only door onto it. A machine-facing internalMutation
 * shell over the same rule shipped alongside it and was removed under D20: no
 * cron registered it and no module called it, so it was a second entry to a gate
 * with nothing behind it — and the second entry is always the one that drifts.
 * `__tests__/rampEntryWiring.test.ts` is what keeps a replacement from arriving
 * unwired. Should a genuine server-side flow ever need to promote, the rule is
 * already the shared one; give it an entry AND the caller in the same change.
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
import { hasSecondSender } from './relayConfiguration';
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
			/**
			 * Whether the rung just written bounds anything — `hasSecondSender`, the
			 * same union the reset door cuts on. Carried out rather than re-derived
			 * because the caller that words the audit sentence would otherwise ask
			 * the question a second time and could answer it differently a tick
			 * later, leaving one timeline with two accounts of one deployment.
			 */
			readonly bindsLadder: boolean;
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
 * the caller owns that, because only the caller knows whom to attribute the move
 * to, and a rule that audited on its own behalf would have to invent an actor.
 *
 * The organization is a PARAMETER rather than a session read, so the rule never
 * depends on there being a session: `promoteCellPhase` takes it from one, and a
 * server-side caller would resolve it the way the cron does. No resolver can
 * name someone else's row — the index read behind `loadRouteStateCell` is
 * org-leading.
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
	return {
		status: 'promoted',
		fromCeiling: current,
		phaseCeiling,
		share,
		bindsLadder: await hasSecondSender(ctx, degradation),
	};
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
			message: promotionMessage({
				cell,
				phaseCeiling: promotion.phaseCeiling,
				share: promotion.share,
				bindsLadder: promotion.bindsLadder,
			}),
			detail: {
				phaseCeiling: promotion.phaseCeiling,
				fromPhaseCeiling: promotion.fromCeiling,
				// The rung was recorded but it bounds nothing — the one fact this row
				// would otherwise be read as claiming (the same shape as the phase
				// reset's `shareHeld` and the enrolment's `shareNotRouted`).
				...(promotion.bindsLadder ? {} : { ceilingNotBinding: true }),
			},
			at: now,
		});
		return { applied: true, phaseCeiling: promotion.phaseCeiling };
	},
});

/**
 * THE AUDIT SENTENCE, AND IT NAMES ONLY WHAT THE RUNG DOES.
 *
 * Two outcomes, because a rung is not the same fact on both actuators. Where the
 * phase ladder binds, the ceiling is the bound the share climbs to on the
 * ordinary gates, and the sentence says so. Where it does not — a cell on the
 * PACE dial, which `phaseLadderBounds` drops both phase bounds for — nothing
 * climbs toward the rung at all: the cell is already at full share, so promising
 * a climb toward a ceiling it stands ABOVE describes a move the controller will
 * never make, on the very row `RampDecisionTimeline` renders back forever. The
 * enrolment row two decisions earlier already told this operator there is no
 * relay; a promotion row contradicting it is the timeline arguing with itself.
 *
 * The rung is still worth recording and still worth earning — it binds again the
 * tick a second sender appears, which is the same rule `resetCellPhase` states
 * from the downward side.
 */
function promotionMessage(args: {
	readonly cell: DeliverabilityCell;
	readonly phaseCeiling: number;
	readonly share: number;
	readonly bindsLadder: boolean;
}): string {
	const key = deliverabilityCellKey(args.cell);
	const rung = `${Math.round(args.phaseCeiling * 100)}%`;
	const percent = `${Math.round(args.share * 100)}%`;
	return args.bindsLadder
		? `An operator promoted ${key} to the ${rung} phase; the promotion evidence allowed it. The share stays at ${percent} and climbs toward the new ceiling on the ordinary gates.`
		: `An operator promoted ${key} to the ${rung} phase; the promotion evidence allowed it. No relay is carrying this cell, so the phase ladder does not bound its share: the share stays at ${percent}, the warm-up pace is what ramps, and the rung applies again once a second sender appears.`;
}
