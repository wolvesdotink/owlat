/**
 * PUTTING A CELL ON THE RAMP — the opt-in (plan D1, D3, D14).
 *
 * NOTHING ELSE WRITES A CELL'S FIRST SHARE. The MTA snapshot writes STREAM-LESS
 * rows and never an `ownShare`; the controller reads `ownShare === undefined` as
 * "not mine" and leaves the cell alone; every control refuses an unmanaged cell
 * rather than creating one. That is deliberate — D1's promise is that shipped
 * routing does not change until someone asks — but it means the ramp needs one
 * door, and this is it: an admin-gated, org-scoped, audited act that turns the
 * shipped boolean into a measured share.
 *
 * WHICH SHARE THE CELL OPENS ON IS THE SETUP FORK'S ANSWER (D14 x D3), read from
 * `ramp/setupFork.ts` rather than decided here. With a relay configured the cell
 * enrols on the ESP path and opens at its stream's `initialShareFraction` — a
 * measured sliver of traffic on the own MTA, the rest still on the relay.
 * Standalone there is no second sender to hold anything back for: the own MTA
 * already carries the mail, s = 1 by definition, and the dial that actually
 * moves is the warming pace.
 *
 * THE FORK AND THE CONTROLLER READ TWO DIFFERENT FACTS, AND THEY ARE ALLOWED TO.
 * The fork reads CONFIGURATION — "is a relay connected" (`configuredRelayKinds`),
 * the only fact available at the instant of enrolment, because a cell that has
 * never been cut has no relay traffic to observe. Every later tick reads
 * MEASUREMENT — reference-arm outcome rows for this cell in the last 24h, folded
 * by `resolveRampDegradation`. On a freshly-configured relay those disagree for
 * one window: enrolment opens the cell at 2%, and until that 2% cut has actually
 * produced relay traffic the controller still treats the cell as pace-actuated.
 * THE DIVERGENCE CONVERGES BY ITSELF, and in the safe direction — the cut is
 * what creates the traffic the measurement then sees, and while it has not the
 * controller runs the standalone (stricter) constants. Enrolment must NOT read
 * the measurement instead: it would answer "pace" for every ESP enrolment ever
 * made, and no cell would ever open at its stream's share.
 *
 * AND NEITHER FACT IS WRITTEN DOWN AS A RUNG. The actuator is a property of the
 * tick, never of the enrolment (see `phaseCeiling` below).
 *
 * THE OPENING SHARE CAN BE A CUT. On a healthy provider slice an unmanaged cell
 * resolves to 1.0 (`resolveOwnShare` over the stream-less row), so enrolling a
 * campaign cell on the ESP path takes it from 100% to 2% — traffic moves TO the
 * relay, which is the whole point of ramping. Only the other direction is
 * gated, through the controller's own `readRampIncreaseBlock`.
 *
 * RE-ENROLMENT IS REFUSED, never merged. A cell that already carries a share has
 * a clean streak, a rung, a dwell anchor and possibly a graduation pin standing
 * on it; overwriting them with opening values would silently discard evidence
 * the cell earned, and "start it over" is what `resetCellPhase` is for.
 */

import {
	deliverabilityCellKey,
	isFallbackActiveForShare,
	OWN_SHARE_CEILING,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getMutationContext, getSingletonOrganizationId } from '../lib/sessionOrganization';
import { loadRouteStateCell } from '../lib/deliverabilityRouteState';
import { configuredRelayKinds } from './alignmentPreflight';
import { RAMP_INITIAL_PHASE_CEILING } from './ramp/controllerConfig';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { resolveSetupPath, type RampSetupPathId } from './ramp/setupFork';
import { readRampIncreaseBlock } from './rampControllerInputs';
import { recordOperatorRampAction } from './rampControlAudit';
import type { RampControlRefusal } from './rampControls';
import {
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from './deliverabilityValidators';
import { ROUTE_STATE_TTL_MS } from './rampControllerWrites';

export interface RampEnrollmentResult {
	readonly enrolled: boolean;
	readonly refusal?: RampControlRefusal;
	/** The share the cell now starts from. Absent on a refusal. */
	readonly share?: number;
	/** Which setup path the deployment enrolled on (plan D14). Absent on a refusal. */
	readonly path?: RampSetupPathId;
}

/**
 * Put a `(stream, destinationProvider)` cell under ramp management.
 *
 * Admin-gated and org-scoped FROM THE SESSION — the cell comes from the
 * arguments, the tenant never does, so a caller can name any cell and still only
 * ever touch their own row.
 */
export const enrollCell = adminMutation({
	args: {
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
	},
	handler: async (ctx, args): Promise<RampEnrollmentResult> => {
		const { userId } = await getMutationContext(ctx);
		const organizationId = await getSingletonOrganizationId(ctx);
		const cell: DeliverabilityCell = {
			stream: args.stream,
			destinationProvider: args.destinationProvider,
		};
		const now = Date.now();
		const { perStream, streamless } = await loadRouteStateCell(ctx, organizationId, cell);
		if (perStream !== null && perStream.ownShare !== undefined) {
			return { enrolled: false, refusal: 'cell_already_ramp_managed' };
		}

		// THE FORK IS READ OFF THE DEPLOYMENT, not off an argument. "Do I have a
		// relay to ramp against" is a fact about the configuration, and a caller-
		// supplied path could claim an ESP arm that does not exist — which would
		// route a measured share of real mail into nothing.
		const setup = resolveSetupPath({
			hasRelayConfigured: (await configuredRelayKinds(ctx)).length > 0,
		});
		// THE ESP PATH OPENS AT THE STREAM'S OWN NUMBER — campaign 2%, automation 5%,
		// transactional 0%, because transactional is the mail a failure hurts most
		// and it ramps last. The own-server path has no second sender to hold a share
		// back for, so it opens at 1 and the WARMING PACE is the dial that ramps;
		// anything less would route mail to a relay this deployment does not have.
		//
		// THE RUNG IS THE LADDER'S FIRST ONE ON BOTH PATHS. A rung is EARNED — the
		// promotion gate is the only thing that raises one — while WHETHER the
		// ladder binds a cell at all is a property of the TICK, re-resolved from the
		// actuator on every evaluation (`isPhaseLadderBinding`). So the own-server
		// path does not need the top rung to keep the controller off its share, and
		// stamping one here would be worse than useless: the actuator is not a
		// property of the enrolment, and the day a relay appears the cell would be
		// standing on a ceiling nobody was promoted to, free to climb to full share
		// without the evidence gate ever being consulted.
		const share =
			setup.actuator === 'share'
				? RAMP_STREAM_CONFIGS[args.stream].initialShareFraction
				: OWN_SHARE_CEILING;
		const phaseCeiling = RAMP_INITIAL_PHASE_CEILING;

		// TODAY'S EFFECTIVE SHARE is the shipped resolution over whichever row
		// governs the cell now — the per-stream row if one exists without a share,
		// else the MTA's stream-less snapshot. Enrolment is an INCREASE only when it
		// raises that number, and only an increase meets the hard stops, exactly as
		// a force-advance does. A cut toward the relay is never blocked.
		const fromShare = resolveOwnShare(perStream ?? streamless);
		if (share > fromShare) {
			const block = await readRampIncreaseBlock(ctx, { organizationId, cell, perStream, now });
			if (block !== null) return { enrolled: false, refusal: block };
		}

		await writeEnrolledCell(ctx, { organizationId, cell, perStream, share, phaseCeiling, now });
		await recordOperatorRampAction(ctx, {
			organizationId,
			userId,
			cell,
			action: 'deliverability_ramp.cell_enrolled',
			reason: 'operator_enrollment',
			fromShare,
			toShare: share,
			message:
				setup.actuator === 'share'
					? `An operator put ${deliverabilityCellKey(cell)} on the ramp at ${Math.round(share * 100)}%; the relay carries the rest. The controller decides every step from here on the gates.`
					: `An operator put ${deliverabilityCellKey(cell)} on the ramp. There is no relay to move traffic away from, so the whole cell sends from your own server and the warm-up pace is what ramps.`,
			detail: { path: setup.id, actuator: setup.actuator, phaseCeiling },
			at: now,
		});
		return { enrolled: true, share, path: setup.id };
	},
});

/**
 * The cell's opening state, as one insert or one patch.
 *
 * `phaseCeilingSince` is stamped WITH the rung it belongs to. The dwell clock
 * measures time served at a rung and it is one of the four conditions on the
 * standalone promotion route — the only route a yahoo/apple/other cell has — so a
 * cell enrolled without an anchor would depend on a backfill to ever be
 * promotable.
 *
 * `mixVersion` advances because enrolment IS a mix generation (plan D7): the
 * cell's recipients are being assigned to two arms for the first time, and a
 * cell re-enrolled after a spell off the ramp must not reuse the previous
 * generation's assignment.
 *
 * OPENING STATE MEANS OPENING STATE. A share-less per-stream row can only have
 * been written by something that is not the ramp, so anything ramp-shaped
 * already on it was set for no enrolment anybody made: the operator's HAND
 * (`operatorPausedAt`, `operatorPinnedShare`) would silently pause or cap a
 * ramp its owner never touched, the counted-window anchor would postpone the
 * first countable window by up to a day, and the whole PACE dial — multiplier,
 * streak, freeze triple, the per-UTC-day anchor and the interlock's memory —
 * would start the second actuator somewhere nobody put it. All of them are
 * cleared here.
 *
 * THE SHARE FREEZE IS THE ONE EXCEPTION, and it survives deliberately.
 * `frozenUntil` / `freezeStartedAt` / `freezeReason` / `cooldownMs` are
 * EVIDENCE-BEARING — a retreat someone's mail paid for — and the ramp's
 * standing rule is that a cooldown is never raised through
 * (`readRampIncreaseBlock` refuses an enrolment that would raise the share
 * inside one). Clearing them here would make enrolment a laundering path for
 * exactly that state: cut the cell, then re-enrol with the ladder's penalty
 * gone. A freeze is left to expire on its own clock, as everywhere else.
 */
async function writeEnrolledCell(
	ctx: MutationCtx,
	args: {
		readonly organizationId: string;
		readonly cell: DeliverabilityCell;
		readonly perStream: Doc<'deliverabilityRouteStates'> | null;
		readonly share: number;
		readonly phaseCeiling: number;
		readonly now: number;
	}
): Promise<void> {
	const { organizationId, cell, perStream, share, phaseCeiling, now } = args;
	const rampFields = {
		ownShare: share,
		// The derived boolean view of the share stays consistent with it (plan D1).
		isFallbackActive: isFallbackActiveForShare(share),
		phaseCeiling,
		phaseCeilingSince: now,
		cleanStreak: 0,
		mixVersion: (perStream?.mixVersion ?? 0) + 1,
		// A cell enrolling at full share has not GRADUATED — graduation is fourteen
		// green days at 1.0 and the pin drops the relay to standby. Enrolment starts
		// the clock; it does not award anything.
		graduatedAt: undefined,
		greenSince: undefined,
		// NOBODY SET THESE FOR THIS ENROLMENT — see above. The operator's hand and
		// the window anchor first, then the whole second dial.
		operatorPausedAt: undefined,
		operatorPinnedShare: undefined,
		lastCountedAt: undefined,
		paceMultiplier: undefined,
		paceCleanStreak: undefined,
		paceFrozenUntil: undefined,
		paceFreezeStartedAt: undefined,
		paceFreezeReason: undefined,
		paceCooldownMs: undefined,
		paceLastEvaluatedUtcDay: undefined,
		paceDeferredAt: undefined,
		// The ramp's own clock. See `applyDecision` for why `updatedAt` is the
		// snapshot writer's and is left alone on a row that already exists.
		decidedAt: now,
		expiresAt: now + ROUTE_STATE_TTL_MS,
	};
	if (perStream !== null) {
		await ctx.db.patch(perStream._id, rampFields);
		return;
	}
	await ctx.db.insert('deliverabilityRouteStates', {
		organizationId,
		destinationProvider: cell.destinationProvider,
		stream: cell.stream,
		// NO SIGNALS, and `updatedAt` set: a brand-new row carries no MTA verdicts,
		// so stamping the freshness clock here re-arms nothing. It is the honest
		// value — this row was written now — and the hard-stop readers skip rows
		// they have not heard from, which an empty row would fail anyway.
		signals: [],
		snapshotGeneratedAt: now,
		updatedAt: now,
		...rampFields,
	});
}
