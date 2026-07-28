/**
 * THE CONTROLS — pause, pin, force-advance, reset-to-phase, presets (P3-6).
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
 *     checks the retreat first and once). A gate breach, an open breaker, a
 *     critical blocklist listing or a capacity ceiling all still take the share
 *     down through a pause. A safety response an operator can switch off is not
 *     a safety response.
 *   - reach a hard stop, the multiplicative decrease, the share floor or the
 *     cooldown ladder through a preset. `RampPresetTuning` has no field that
 *     could express any of them.
 *   - force-advance from a single click. The consequence-naming phrase is
 *     checked HERE, server-side, so a client that skipped its dialog is refused
 *     by the same rule the dialog renders.
 *
 * AN UNMANAGED CELL IS REFUSED CALMLY, never created. Writing a row with an
 * `ownShare` would opt a cell into the ramp as a side effect of pausing it —
 * which is the opposite of what the operator asked for, and a behaviour change
 * D1 does not sanction.
 */

import { v } from 'convex/values';
import {
	clampOwnShare,
	deliverabilityCellKey,
	isFallbackActiveForShare,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import {
	FORCE_ADVANCE_CONFIRMATION,
	isConfirmationPhraseMatch,
	isRampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getMutationContext, getSingletonOrganizationId } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { throwInvalidInput } from '../_utils/errors';
import { RAMP_PHASE_CEILINGS } from './ramp/controllerConfig';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
	rampPresetValidator,
} from './deliverabilityValidators';
import { recordOperatorRampAction } from './rampControlAudit';

const cellArgs = {
	stream: deliverabilityStreamValidator,
	destinationProvider: destinationProviderValidator,
} as const;

/** Why a control could not be applied — always calm, never an exception. */
export type RampControlRefusal = 'cell_not_ramp_managed' | 'no_organization';

export interface RampControlResult {
	readonly applied: boolean;
	readonly refusal?: RampControlRefusal;
	readonly share?: number;
}

interface ResolvedCell {
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
async function resolveControlTarget(
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

function refused(refusal: RampControlRefusal): RampControlResult {
	return { applied: false, refusal };
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
		if (typeof target === 'string') return refused(target);
		const now = Date.now();
		const wasPaused = target.row.operatorPausedAt !== undefined;
		if (wasPaused === args.isPaused) return { applied: false, share: target.share };
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
			message: args.isPaused
				? `An operator paused ${deliverabilityCellKey(target.cell)} at ${Math.round(target.share * 100)}%. The gates keep measuring and a retreat would still be applied — only the increase is held.`
				: `An operator resumed ${deliverabilityCellKey(target.cell)}. The ramp may advance again when the gates allow it.`,
			detail: { isPaused: args.isPaused },
			at: now,
		});
		return { applied: true, share: target.share };
	},
});

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
		if (typeof target === 'string') return refused(target);
		if (args.share !== null && !Number.isFinite(args.share)) {
			throwInvalidInput('A pinned share must be a number between 0 and 1.');
		}
		const now = Date.now();
		const pinned = args.share === null ? null : clampOwnShare(args.share);
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
			message:
				pinned === null
					? `An operator unpinned ${deliverabilityCellKey(target.cell)}. The ramp may climb again when the gates allow it.`
					: `An operator pinned ${deliverabilityCellKey(target.cell)} at ${Math.round(pinned * 100)}%. The ramp will not climb past that share until it is unpinned.`,
			detail: { pinnedShare: pinned },
			at: now,
		});
		return { applied: true, share: target.share };
	},
});

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
		if (typeof target === 'string') return refused(target);
		const now = Date.now();
		const share = clampOwnShare(args.share);
		await ctx.db.patch(target.row._id, {
			ownShare: share,
			// The derived view of the share stays consistent with it (plan D1).
			isFallbackActive: isFallbackActiveForShare(share),
			// A manual move is a new mix generation: the cohort is deliberately
			// re-randomised, exactly as it is on a phase promotion (plan D7).
			mixVersion: (target.row.mixVersion ?? 0) + 1,
			// The streak is NOT carried across a move nobody measured.
			cleanStreak: 0,
			greenSince: undefined,
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
			detail: { forcedShare: share },
			at: now,
		});
		return { applied: true, share };
	},
});

// ============ RESET TO A PHASE ============

/**
 * Put a cell back on a phase rung (0.25 / 0.5 / 0.8 / 1.0).
 *
 * THE RUNG IS VALIDATED AGAINST THE LADDER, not merely clamped: an arbitrary
 * ceiling would invent a rung the promotion path can never reach and leave the
 * cell somewhere the phase ladder has no name for. Resetting DOWN also brings
 * the share back under the new ceiling immediately — leaving a cell above a
 * ceiling it was just given would be a ceiling in name only.
 */
export const resetCellPhase = adminMutation({
	args: { ...cellArgs, phaseCeiling: v.number() },
	handler: async (ctx, args): Promise<RampControlResult> => {
		if (!(RAMP_PHASE_CEILINGS as readonly number[]).includes(args.phaseCeiling)) {
			throwInvalidInput(
				`A phase ceiling must be one of the ladder's rungs: ${RAMP_PHASE_CEILINGS.join(', ')}.`
			);
		}
		const target = await resolveControlTarget(ctx, args);
		if (typeof target === 'string') return refused(target);
		const now = Date.now();
		const share = Math.min(target.share, args.phaseCeiling);
		await ctx.db.patch(target.row._id, {
			phaseCeiling: args.phaseCeiling,
			ownShare: share,
			isFallbackActive: isFallbackActiveForShare(share),
			mixVersion: (target.row.mixVersion ?? 0) + 1,
			cleanStreak: 0,
			greenSince: undefined,
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
			message: `An operator reset ${deliverabilityCellKey(target.cell)} to the ${Math.round(args.phaseCeiling * 100)}% phase. The clean streak restarts at zero and the ramp re-earns its way up.`,
			detail: { phaseCeiling: args.phaseCeiling },
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
	handler: async (ctx, args): Promise<{ applied: boolean }> => {
		const { userId } = await getMutationContext(ctx);
		const organizationId = await getSingletonOrganizationId(ctx);
		if (args.preset !== null && !isRampPreset(args.preset)) {
			throwInvalidInput('Unknown ramp preset.');
		}
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
