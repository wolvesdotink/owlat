/**
 * THE CONTROLS — pause, pin, force-advance, presets (P3-6).
 *
 * DELIVERABILITY FEATURES FAIL WHEN THEY FEEL LIKE MAGIC. A controller that
 * moves a share on its own is only trustworthy if a human can stop it, hold it,
 * push it, or start it over — and can see afterwards that they did. Every
 * mutation here is admin-gated, org-scoped FROM THE SESSION (there is no
 * `organizationId` argument to forge), and writes both a `mixDecisions` row and
 * an `auditLogs` entry through the one shared helper (plan D12).
 *
 * WHAT AN OPERATOR CANNOT DO, by construction rather than by convention:
 *
 *   - hold a RETREAT. Pause and pin bound INCREASES only (`applyRampCellControl`
 *     and `applyPaceCellControl` each check the retreat first and once). A gate
 *     breach, an open breaker, a critical blocklist listing or a capacity ceiling
 *     all still take the share — and the warm-up pace — down through a pause. A
 *     safety response an operator can switch off is not a safety response.
 *   - hold the PACE dial with a PIN. A pause reaches both dials; a pin is
 *     expressed in share and there is no honest conversion into a multiplier on a
 *     daily cap. The cap itself always binds — the tick decides and writes a
 *     share for every managed cell, whichever dial it ramps — but on a cell the
 *     controller ramps by PACE it bounds the dial that is not climbing, and the
 *     row it writes says so and names the control that holds the other one (see
 *     `pinMessage`).
 *   - reach a hard stop, the multiplicative decrease, the share floor or the
 *     cooldown ladder through a preset. `RampPresetTuning` has no field that
 *     could express any of them.
 *   - force-advance from a single click. The consequence-naming phrase is
 *     checked HERE, server-side, so a client that skipped its dialog is refused
 *     by the same rule the dialog renders.
 *   - raise a share past a hard stop. Force-advance writes a share directly, so
 *     it asks `readRampIncreaseBlock` — the controller's own readers — before any
 *     INCREASE, and is refused calmly while the global kill switch is engaged,
 *     while sending is abuse-suspended, while a breaker or critical blocklist
 *     listing stands, or inside a live cooldown. Moving a cell DOWN is never
 *     blocked by any of them.
 *   - move a PHASE CEILING from here at all. The rung has its own two doors and
 *     they are separate modules: `rampPhaseReset.resetCellPhase` takes it down,
 *     `rampPhasePromotion.promoteCellPhase` runs the plan's evidence routes to
 *     take it up. A ceiling that could also rise on a control with no evidence
 *     behind it would leave the gate guarding one of two doors.
 *
 * AN UNMANAGED CELL IS REFUSED CALMLY, never created. Writing a row with an
 * `ownShare` would opt a cell into the ramp as a side effect of pausing it —
 * which is the opposite of what the operator asked for, and a behaviour change
 * D1 does not sanction. Opting in is its own deliberate act, and it has its own
 * mutation: `rampEnrollment.enrollCell`.
 *
 * THE REFUSAL UNION, THE RESULT SHAPE AND THE TARGET RESOLUTION ARE SHARED, and
 * they live here because this is where the first control needed them. The two
 * phase doors and enrolment import them rather than restate them — a second
 * resolution is a second chance to read a cell without the session's tenant.
 */

import { v } from 'convex/values';
import {
	clampOwnShare,
	deliverabilityCellKey,
	isFallbackActiveForShare,
	OWN_SHARE_CEILING,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import {
	FORCE_ADVANCE_CONFIRMATION,
	isConfirmationPhraseMatch,
} from '@owlat/shared/deliverabilityIndependence';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getMutationContext, getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { throwInvalidInput } from '../_utils/errors';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
	rampPresetValidator,
} from './deliverabilityValidators';
import { readRampIncreaseBlock } from './rampHardStops';
import { recordOperatorRampAction } from './rampControlAudit';
import { loadCellDegradation } from './rampIntegrationPresence';
import { bindsPhaseLadder } from './ramp/degradation';

const cellArgs = {
	stream: deliverabilityStreamValidator,
	destinationProvider: destinationProviderValidator,
} as const;

/**
 * Why a control could not be applied — always calm, never an exception.
 *
 * ONE VOCABULARY FOR EVERY RAMP WRITE, enrolment and promotion included: the
 * screens render these through a single sentence map, and a second refusal union
 * would be a second map, free to go quiet on an arm nobody remembered to add.
 */
export type RampControlRefusal =
	| 'cell_not_ramp_managed'
	// Enrolment only: the cell ALREADY has a stored share. Re-enrolling would
	// discard the streak, the ceiling and the clocks a live ramp is standing on.
	| 'cell_already_ramp_managed'
	// The global kill switch is engaged: "everything held still" means everything.
	| 'controller_paused'
	// Abuse suspension, an open breaker, a critical blocklist listing or a live
	// cooldown. Named as one arm on purpose — the UI's remedy is the same
	// ("clear the condition, then try again") and enumerating which hard stop
	// fired would tell a caller more about the deployment than a refusal should.
	| 'hard_stop_active'
	// A ceiling only ever rises through the evidence gate, so
	// `rampPhaseReset.resetCellPhase` declines the upward move and names the
	// mutation that owns it.
	| 'phase_increase_requires_promotion'
	// The evidence gate consulted its routes and none was satisfied. The
	// outstanding conditions travel back BY NAME alongside this (plan D12/D14).
	| 'promotion_evidence_outstanding';

export interface RampControlResult {
	readonly applied: boolean;
	readonly refusal?: RampControlRefusal;
	readonly share?: number;
}

export interface ResolvedCell {
	readonly organizationId: string;
	readonly userId: string;
	readonly cell: DeliverabilityCell;
	readonly row: Doc<'deliverabilityRouteStates'>;
	readonly share: number;
}

/**
 * The one resolution every control shares: who is asking, which organization
 * they are in, and whether the cell is on the ramp at all.
 *
 * The organization comes from the SESSION and the cell from the ARGUMENTS, so a
 * caller can name any cell they like and still only ever touch their own
 * tenant's row — the index read below is org-leading and there is no argument
 * that could widen it.
 */
export async function resolveControlTarget(
	ctx: MutationCtx,
	args: {
		stream: DeliverabilityCell['stream'];
		destinationProvider: DeliverabilityCell['destinationProvider'];
	}
): Promise<ResolvedCell | RampControlRefusal> {
	const { userId } = await getMutationContext(ctx);
	const organizationId = await getSingletonOrganizationId(ctx);
	const cell: DeliverabilityCell = {
		stream: args.stream,
		destinationProvider: args.destinationProvider,
	};
	const { perStream } = await loadRouteStateCell(ctx, organizationId, cell);
	// `ownShare === undefined` IS the definition of unmanaged (the same one
	// `rampControllerInputs` uses). Creating the row here would opt the cell in.
	if (perStream === null || perStream.ownShare === undefined) return 'cell_not_ramp_managed';
	return {
		organizationId,
		userId,
		cell,
		row: perStream,
		share: resolveOwnShare(perStream),
	};
}

export function refusedControl(refusal: RampControlRefusal): RampControlResult {
	return { applied: false, refusal };
}

/**
 * WHICH DIAL IS THIS CELL'S RAMP — the tick's own answer to its own question.
 *
 * `bindsPhaseLadder` is `actuator === 'share'`, read off the same substitution
 * resolution that chooses the cell's evaluator, its K_CLEAN and its ceiling cap
 * (plan D3). What the audit row TELLS an operator depends on it, and a control
 * that named the dial the controller is NOT climbing would be read back for ever.
 *
 * DELIBERATELY NOT `hasSecondSender`, which is what the two phase doors cut on.
 * That union also counts a relay that is CONFIGURED but carried nothing this
 * window, and the tick does not: it ramps by pace on every cell whose reference
 * arm it cannot measure. A sentence worded off the union would promise the share
 * as the climbing dial on a cell the next tick ramps by pace. Whether a relay is
 * configured is a second, separate fact, and it stays out of these sentences
 * rather than being soldered onto the dial claim.
 *
 * One helper over one loaded degradation — reading it twice inside one mutation
 * would let two halves of one sentence answer off two different ticks.
 */
async function readsShareDial(
	ctx: MutationCtx,
	target: ResolvedCell,
	now: number
): Promise<boolean> {
	return bindsPhaseLadder(
		await loadCellDegradation(ctx, {
			organizationId: target.organizationId,
			cell: target.cell,
			now,
		})
	);
}

// ============ PAUSE ============

/**
 * Hold a cell where it is — or let it move again.
 *
 * A pause is deliberately NOT the global kill switch: the switch pins every
 * cell and is an incident control, while this is a per-cell "I am watching this
 * one, do not advance it". The controller keeps evaluating and keeps auditing a
 * paused cell, so an operator can watch what it would have done.
 */
export const setCellPause = adminMutation({
	args: { ...cellArgs, isPaused: v.boolean() },
	handler: async (ctx, args): Promise<RampControlResult> => {
		const target = await resolveControlTarget(ctx, args);
		if (typeof target === 'string') return refusedControl(target);
		const now = Date.now();
		const wasPaused = target.row.operatorPausedAt !== undefined;
		if (wasPaused === args.isPaused) return { applied: false, share: target.share };
		// WHICH DIAL THE CONTROLLER IS RAMPING HERE, off the tick's own resolution
		// rather than a predicate of this module's own. The pause reaches BOTH dials
		// either way (`applyRampCellControl`, `applyPaceCellControl`); what the row has
		// to name is the one that was climbing, because that is the one the operator
		// came to stop. Read AFTER the idempotent early return, so pausing an
		// already-paused cell pays for nothing.
		const rampsShare = await readsShareDial(ctx, target, now);
		await ctx.db.patch(target.row._id, {
			...(args.isPaused ? { operatorPausedAt: now } : { operatorPausedAt: undefined }),
			decidedAt: now,
		});
		await recordOperatorRampAction(ctx, {
			organizationId: target.organizationId,
			userId: target.userId,
			cell: target.cell,
			action: args.isPaused
				? 'deliverability_ramp.cell_paused'
				: 'deliverability_ramp.cell_resumed',
			reason: 'operator_pause',
			fromShare: target.share,
			toShare: target.share,
			message: pauseMessage({
				cell: target.cell,
				share: target.share,
				isPaused: args.isPaused,
				rampsShare,
			}),
			detail: { isPaused: args.isPaused },
			at: now,
		});
		return { applied: true, share: target.share };
	},
});

/**
 * THE AUDIT SENTENCE, AND IT NAMES THE DIAL THE CONTROLLER WAS RAMPING.
 *
 * Two outcomes, cut on the tick's own actuator reading (`readsShareDial`): one
 * question about one cell, answered once, so its timeline cannot end up carrying
 * two accounts of which dial this deployment climbs.
 *
 * BOTH ARMS NAME BOTH DIALS, because the pause holds both. What differs is which
 * one the controller was actually advancing — the number an operator watches
 * after leaving a pause in place — and neither sentence claims the other dial
 * stands still: the share of a pace-actuated cell is still decided and still
 * written on every tick, and a hard stop still takes it down.
 *
 * THE ONE-DIRECTIONAL RULE IS SAID ON BOTH ARMS on purpose. It is the property an
 * operator is trusting when they leave a pause in place overnight, and a
 * deployment that read it on one arm only would have to guess about the other.
 */
function pauseMessage(args: {
	readonly cell: DeliverabilityCell;
	readonly share: number;
	readonly isPaused: boolean;
	readonly rampsShare: boolean;
}): string {
	const key = deliverabilityCellKey(args.cell);
	const percent = `${Math.round(args.share * 100)}%`;
	if (args.rampsShare) {
		return args.isPaused
			? `An operator paused ${key} at ${percent}. The share is the dial the controller is ramping here, and the warm-up pace is held with it. The gates keep measuring and a retreat would still be applied — only the increase is held.`
			: `An operator resumed ${key}. The share and the warm-up pace may advance again when the gates allow it.`;
	}
	return args.isPaused
		? `An operator paused ${key} at ${percent}. No reference transport is carrying this cell, so the warm-up pace is the dial the controller is ramping here, and the share is held with it. The gates keep measuring and a retreat would still be applied — only the increase is held.`
		: `An operator resumed ${key}. The warm-up pace and the share may advance again when the gates allow it.`;
}

// ============ PIN ============

/**
 * Cap a cell at a share.
 *
 * A CAP, NOT A FLOOR. Pinning at 40% stops the ramp climbing past 40%; it does
 * not hold a cell up at 40% when a gate says otherwise, and it never raises a
 * cell that is currently lower — the pin is reached by the ordinary AIMD steps,
 * on the ordinary evidence. That is what makes a pin safe to leave in place.
 */
export const pinCellShare = adminMutation({
	args: { ...cellArgs, share: v.union(v.number(), v.null()) },
	handler: async (ctx, args): Promise<RampControlResult> => {
		const target = await resolveControlTarget(ctx, args);
		if (typeof target === 'string') return refusedControl(target);
		if (args.share !== null && !Number.isFinite(args.share)) {
			throwInvalidInput('A pinned share must be a number between 0 and 1.');
		}
		const now = Date.now();
		const pinned = args.share === null ? null : clampOwnShare(args.share);
		// THE SAME QUESTION THE PAUSE ASKS, and the pin needs it more: the cap is
		// expressed in SHARE and always binds the share, so on a cell the controller
		// ramps by PACE it bounds the dial that is not climbing. The control is still
		// recorded and still meaningful — it binds the climbing dial again the tick a
		// reference transport is measured — but the sentence must not let an operator
		// walk away believing the cell is capped.
		const rampsShare = await readsShareDial(ctx, target, now);
		await ctx.db.patch(target.row._id, {
			...(pinned === null ? { operatorPinnedShare: undefined } : { operatorPinnedShare: pinned }),
			decidedAt: now,
		});
		await recordOperatorRampAction(ctx, {
			organizationId: target.organizationId,
			userId: target.userId,
			cell: target.cell,
			action:
				pinned === null ? 'deliverability_ramp.cell_unpinned' : 'deliverability_ramp.cell_pinned',
			reason: 'operator_pin',
			fromShare: target.share,
			toShare: target.share,
			message: pinMessage({ cell: target.cell, pinned, rampsShare }),
			detail: { pinnedShare: pinned },
			at: now,
		});
		return { applied: true, share: target.share };
	},
});

/**
 * THE PIN'S SENTENCE, on the same reading and for a sharper reason.
 *
 * A pin is expressed in SHARE, and the tick decides and writes a share for every
 * managed cell whichever dial it ramps, so the cap itself always binds. What it
 * cannot bind is the PACE dial — a multiplier on a daily cap, in units no share
 * converts into. On a cell the controller ramps by pace the cap therefore holds
 * the dial that is not climbing, and the row names the control that holds the
 * other one rather than letting an operator walk away believing the cell is
 * capped. The pin binds the climbing dial again the tick a reference transport is
 * measured, which is the rule both phase doors state from their own side.
 */
function pinMessage(args: {
	readonly cell: DeliverabilityCell;
	readonly pinned: number | null;
	readonly rampsShare: boolean;
}): string {
	const key = deliverabilityCellKey(args.cell);
	if (args.pinned === null) {
		return args.rampsShare
			? `An operator unpinned ${key}. The ramp may climb again when the gates allow it.`
			: `An operator unpinned ${key}. The share may climb again when the gates allow it; the warm-up pace, the dial the controller is ramping here, was never bounded by the pin.`;
	}
	const percent = `${Math.round(args.pinned * 100)}%`;
	return args.rampsShare
		? `An operator pinned ${key} at ${percent}. The ramp will not climb past that share until it is unpinned.`
		: `An operator pinned ${key} at ${percent}. The share will not climb past it, but no reference transport is carrying this cell: the warm-up pace is the dial the controller is ramping here, and no pin can bound it — pausing the cell is what holds it.`;
}

// ============ FORCE-ADVANCE ============

/**
 * Move a cell's share by hand, past the evidence.
 *
 * THE ONE ACTION HERE THAT CAN LOSE REPUTATION, and the only one behind a typed
 * confirmation. The phrase is checked SERVER-SIDE: a client that skipped its
 * dialog, a replayed request and a script all meet the same rule the dialog
 * renders, so "cannot fire from a single click" is a property of the mutation
 * rather than of the component.
 *
 * It does NOT touch the clean streak, the green clock or the graduation pin.
 * Nothing about a manual move is earned, and a force-advance that shortened the
 * fourteen-day graduation clock would let an operator buy a pin the measurement
 * never supported.
 */
export const forceAdvanceCellShare = adminMutation({
	args: { ...cellArgs, share: v.number(), confirmation: v.string() },
	handler: async (ctx, args): Promise<RampControlResult> => {
		if (!isConfirmationPhraseMatch(args.confirmation, FORCE_ADVANCE_CONFIRMATION)) {
			throwInvalidInput(
				`Force-advance needs its consequence confirmed: type “${FORCE_ADVANCE_CONFIRMATION}” to proceed.`
			);
		}
		if (!Number.isFinite(args.share)) {
			throwInvalidInput('A forced share must be a number between 0 and 1.');
		}
		const target = await resolveControlTarget(ctx, args);
		if (typeof target === 'string') return refusedControl(target);
		const now = Date.now();
		const share = clampOwnShare(args.share);
		// A HAND ON THE CONTROL IS STILL A HAND INSIDE THE HARD STOPS. Raising the
		// share is refused while the ramp is globally paused or while a hard stop is
		// live; lowering it never is. Same shape as a phase promotion, and through
		// the controller's own readers rather than a second copy of the rules.
		if (share > target.share) {
			const block = await readRampIncreaseBlock(ctx, {
				organizationId: target.organizationId,
				cell: target.cell,
				perStream: target.row,
				now,
			});
			if (block !== null) return refusedControl(block);
		}
		await ctx.db.patch(target.row._id, {
			ownShare: share,
			// The derived view of the share stays consistent with it (plan D1).
			isFallbackActive: isFallbackActiveForShare(share),
			// A manual move is a new mix generation: the cohort is deliberately
			// re-randomised, exactly as it is on a phase promotion (plan D7).
			mixVersion: (target.row.mixVersion ?? 0) + 1,
			// The streak is NOT carried across a move nobody measured — and neither
			// is the GRADUATION PIN when the move lands below 1.0. A graduated cell
			// hand-moved to 25% is not graduated: leaving the pin in place would
			// render it as "Graduated" in the Cells grid and count it as no longer
			// leaning on the relay in the removal-safety projection, while three
			// quarters of its mail was back on the relay.
			cleanStreak: 0,
			greenSince: undefined,
			...(share < OWN_SHARE_CEILING ? { graduatedAt: undefined } : {}),
			decidedAt: now,
		});
		await recordOperatorRampAction(ctx, {
			organizationId: target.organizationId,
			userId: target.userId,
			cell: target.cell,
			action: 'deliverability_ramp.force_advanced',
			reason: 'operator_force_advance',
			fromShare: target.share,
			toShare: share,
			message: `An operator forced ${deliverabilityCellKey(target.cell)} to ${Math.round(share * 100)}% without waiting for the gates. The clean streak restarts at zero; the next evaluation measures the result and will retreat if it is bad.`,
			detail: {
				forcedShare: share,
				...(share < OWN_SHARE_CEILING && target.row.graduatedAt !== undefined
					? { pinChange: 'revoked' }
					: {}),
			},
			at: now,
		});
		return { applied: true, share };
	},
});

// ============ PRESETS ============

/**
 * Choose how hard one stream ramps.
 *
 * A row only exists where a human chose one; deleting the choice returns the
 * stream to the deployment default (plan D14) rather than to a stored
 * "balanced", so a deployment that later connects a relay picks up the new
 * default automatically instead of silently keeping a conservative pace it never
 * asked for.
 */
export const setStreamPreset = adminMutation({
	args: { stream: deliverabilityStreamValidator, preset: v.union(rampPresetValidator, v.null()) },
	handler: async (ctx, args): Promise<{ readonly applied: true }> => {
		const { userId } = await getMutationContext(ctx);
		const organizationId = await getSingletonOrganizationId(ctx);
		const now = Date.now();
		const existing = await ctx.db
			.query('rampStreamPresets')
			.withIndex('by_org_stream', (q) =>
				q.eq('organizationId', organizationId).eq('stream', args.stream)
			)
			.first();
		if (args.preset === null) {
			if (existing !== null) await ctx.db.delete(existing._id);
		} else if (existing === null) {
			await ctx.db.insert('rampStreamPresets', {
				organizationId,
				stream: args.stream,
				preset: args.preset,
				updatedAt: now,
				updatedByUserId: userId,
			});
		} else {
			await ctx.db.patch(existing._id, {
				preset: args.preset,
				updatedAt: now,
				updatedByUserId: userId,
			});
		}
		// A preset is a STREAM-level choice, not a cell-level decision, so it earns
		// an audit entry and no `mixDecisions` row: the cells it affects will record
		// their own decisions on the next tick, under the new constants.
		await recordAuditLog(ctx, {
			userId,
			organizationId,
			action: 'deliverability_ramp.preset_changed',
			resource: 'deliverability_ramp',
			resourceId: args.stream,
			details: { stream: args.stream, preset: args.preset ?? 'default' },
		});
		return { applied: true };
	},
});
