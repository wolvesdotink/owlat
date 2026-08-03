/**
 * THE DOWNWARD PHASE DOOR (plan D3, D12).
 *
 * A rung moves in exactly two places and they are deliberately not the same
 * module: `rampPhasePromotion` raises one on the evidence routes, and this
 * lowers one on an operator's word. Splitting them that way is the whole design
 * — a single mutation that could do both would make the evidence gate an
 * argument rather than a rule — and it is why this file sits beside the
 * promotion rather than inside the controls: pause, pin and force-advance move
 * the SHARE, this moves the CEILING the share may climb to.
 *
 * The refusal union, the result shape and the target resolution stay in
 * `rampControls`: one vocabulary across every ramp write, and one org-scoped
 * lookup that no caller can widen.
 */

import { v } from 'convex/values';
import {
	deliverabilityCellKey,
	isFallbackActiveForShare,
	OWN_SHARE_CEILING,
} from '@owlat/shared/deliverabilityRouting';
import { adminMutation } from '../lib/authedFunctions';
import { throwInvalidInput } from '../_utils/errors';
import { configuredRelayKinds } from './relayConfiguration';
import { normalizePhaseCeiling, RAMP_PHASE_CEILINGS } from './ramp/controllerConfig';
import { bindsPhaseLadder } from './ramp/degradation';
import { loadCellDegradation } from './rampIntegrationPresence';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';
import { recordOperatorRampAction } from './rampControlAudit';
import { refusedControl, resolveControlTarget, type RampControlResult } from './rampControls';

/**
 * Put a cell back DOWN on a phase rung (0.25 / 0.5 / 0.8 / 1.0).
 *
 * THE RUNG IS VALIDATED AGAINST THE LADDER, not merely clamped: an arbitrary
 * ceiling would invent a rung the promotion path can never reach and leave the
 * cell somewhere the phase ladder has no name for. Resetting DOWN also brings
 * the share back under the new ceiling immediately — leaving a cell above a
 * ceiling it was just given would be a ceiling in name only — but only where
 * there is a SECOND SENDER to hold that share back for. A standalone deployment
 * keeps its share and takes the rung.
 *
 * A RESET RESTARTS THE EVIDENCE CLOCKS ON BOTH PATHS — the clean streak, the
 * rung's dwell anchor and the green (graduation) clock. All three measure the
 * stretch an operator has just declared they do not trust, and a standalone cell
 * that kept a thirteen-day green clock would run out its fourteenth day and PIN
 * two days after being taken off its rung. WHAT FOLLOWS THE SHARE — the boolean
 * view, the mix generation and the graduation pin already on the row — moves
 * only where the share moved: the pin is a claim about which sender carries the
 * cell's mail, so a cut below full share revokes it and a held share leaves the
 * claim true. Earned-ness is not what spares it; the share is.
 *
 * DOWNWARD ONLY, and that is the point. A RESET IS NOT A PROMOTION: raising a
 * ceiling opens the share to the next rung and, where a second sender splits the
 * cell, re-shuffles which arm every recipient lands in — which is exactly the
 * move plan D3's evidence gate exists to guard. Letting this mutation do it too — on nothing but the hard-stop
 * check, with no promotion evidence and no typed confirmation — would make the
 * gate optional, and an optional gate is not a gate. The upward move lives in
 * `rampPhasePromotion.promoteCellPhase` and nowhere else.
 */
export const resetCellPhase = adminMutation({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
		phaseCeiling: v.number(),
	},
	handler: async (ctx, args): Promise<RampControlResult> => {
		if (!(RAMP_PHASE_CEILINGS as readonly number[]).includes(args.phaseCeiling)) {
			throwInvalidInput(
				`A phase ceiling must be one of the ladder's rungs: ${RAMP_PHASE_CEILINGS.join(', ')}.`
			);
		}
		const target = await resolveControlTarget(ctx, args);
		if (typeof target === 'string') return refusedControl(target);
		const now = Date.now();
		// THE SAME READING THE PROMOTION PATH TAKES, through the same helper — a row
		// with no stored ceiling sits on the ladder's first rung, and a degenerate
		// one snaps DOWN onto a real rung rather than standing above the ladder. So
		// "is this upward?" is answered against the rung the cell is actually on,
		// not against the argument (which would compare a value with itself and wave
		// every raise through) and not against a raw stored number (which would read
		// a corrupt 1.2 as a rung above the top and let a raise to 1.0 through as a
		// "reset").
		const currentCeiling = normalizePhaseCeiling(target.row.phaseCeiling);
		if (args.phaseCeiling > currentCeiling)
			return refusedControl('phase_increase_requires_promotion');
		// THE SHARE IS CUT ONLY WHERE THERE IS A SECOND SENDER TO HOLD IT BACK FOR
		// (plan D3). Cutting a standalone cell from 1.0 to the 25% rung would move
		// three quarters of its mail toward a relay that does not exist, flip
		// `isFallbackActive`, revoke a graduation pin and re-randomise a cohort with
		// one arm in it — the move `phaseLadderBounds` was added to prevent, arrived
		// at from the operator's door instead.
		//
		// AND "IS THERE ONE" IS A CONFIGURATION QUESTION AT THIS DOOR, asked of the
		// same reader the enrolment door asks (`configuredRelayKinds`). Asking the
		// tick's MEASUREMENT alone denied the relay for exactly the cell this
		// control exists for: a graduated cell sits at full share and pinned, so it
		// sends nothing through the relay by construction, so it has no reference
		// arm — and "start it over" could never start it over. A configured relay is
		// one the cut can move mail to, and the cut is what creates the traffic the
		// tick then measures (the enrolment fork's own convergence, D14 x D3).
		//
		// THE MEASURED ARM IS THE OTHER HALF OF THE UNION, not a leftover: a relay
		// disconnected in the last day can still be carrying this cell inside the
		// evaluation window, and the tick binds the ladder on that reading. The
		// operator's door must not hold a share the controller is already bounding.
		//
		// THE RUNG STILL GOES DOWN either way, and so do the evidence clocks. The
		// rung is stored state the promotion gate makes the cell re-earn, and
		// restarting the measurement is the reason this control exists; both are
		// meaningful on a cell whose share nothing is bounding today, and the rung
		// binds again the tick a second sender appears.
		const hasSecondSender =
			(await configuredRelayKinds(ctx)).length > 0 ||
			bindsPhaseLadder(
				await loadCellDegradation(ctx, {
					organizationId: target.organizationId,
					cell: target.cell,
					now,
				})
			);
		const share = hasSecondSender ? Math.min(target.share, args.phaseCeiling) : target.share;
		await ctx.db.patch(target.row._id, {
			phaseCeiling: args.phaseCeiling,
			// THE DWELL CLOCK RESTARTS HERE. It measures time served AT A RUNG, and a
			// reset is a deliberate restart at one: a cell dropped from 1.0 to 0.25
			// that kept its old anchor would arrive on the low rung with that rung's
			// dwell already served, and the standalone promotion route — the only route
			// a yahoo/apple/other cell has — would hand the ceiling straight back.
			phaseCeilingSince: now,
			// THE OTHER TWO EVIDENCE CLOCKS RESTART TOO, on both paths and for the
			// same reason: they measure the stretch this reset declares untrusted.
			// The green one is the fourteen-day graduation hold, so a standalone cell
			// whose share was held would otherwise finish it and PIN days after an
			// operator put it back on a lower rung.
			cleanStreak: 0,
			greenSince: undefined,
			// WHAT FOLLOWS THE SHARE MOVES ONLY WHERE THE SHARE MOVED: the boolean
			// view, the mix generation and the graduation pin all describe a traffic
			// split this reset did not touch on a standalone cell.
			//
			// AND THIS IS THE ONLY DOOR THAT HOLDS THE GENERATION BACK — because of
			// the SHARE, not the arm count. Enrolment, promotion and force-advance
			// always write the move they were called for, so they bump `mixVersion`
			// unconditionally, on a one-arm cell too; that is inert, because the salt
			// only decides anything where the route splits by share (`adaptive_mix`)
			// and is otherwise copied onto the assignment row as a label that moves
			// nobody. Here the share can stay exactly where it was, and a generation
			// spent on a split that did not move would be the one field on this patch
			// claiming a change nobody made.
			...(hasSecondSender
				? {
						ownShare: share,
						isFallbackActive: isFallbackActiveForShare(share),
						mixVersion: (target.row.mixVersion ?? 0) + 1,
						// See `forceAdvanceCellShare`: a cell put back on a lower rung has
						// not graduated, and the pin must not outlive the share that
						// earned it.
						...(share < OWN_SHARE_CEILING ? { graduatedAt: undefined } : {}),
					}
				: {}),
			decidedAt: now,
		});
		await recordOperatorRampAction(ctx, {
			organizationId: target.organizationId,
			userId: target.userId,
			cell: target.cell,
			action: 'deliverability_ramp.phase_reset',
			reason: 'operator_phase_reset',
			fromShare: target.share,
			toShare: share,
			message: hasSecondSender
				? `An operator reset ${deliverabilityCellKey(target.cell)} to the ${Math.round(args.phaseCeiling * 100)}% phase. The clean streak restarts at zero and the ramp re-earns its way up.`
				: `An operator reset ${deliverabilityCellKey(target.cell)} to the ${Math.round(args.phaseCeiling * 100)}% phase. The clean streak restarts at zero. No relay is connected and none has carried this cell, so there is no second sender to hold a share back for: the share stays at ${Math.round(share * 100)}% and the rung applies again once one is.`,
			detail: {
				phaseCeiling: args.phaseCeiling,
				// The rung was recorded but nothing was cut — the one fact this row
				// would otherwise be read as claiming.
				...(hasSecondSender ? {} : { shareHeld: true }),
				...(hasSecondSender && share < OWN_SHARE_CEILING && target.row.graduatedAt !== undefined
					? { pinChange: 'revoked' }
					: {}),
			},
			at: now,
		});
		return { applied: true, share };
	},
});
