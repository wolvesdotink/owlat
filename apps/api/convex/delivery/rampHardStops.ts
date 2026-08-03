/**
 * THE RAMP'S HARD STOPS, READ OFF THE ROWS — and the one question every door
 * that can RAISE a cell has to ask first (plan D2, D13, P3-6).
 *
 * Split out of `rampControllerInputs.ts` when that file passed the ~500 LOC line
 * the conventions draw: the tick's read half is one job, and "does anything
 * forbid moving this cell UP right now" is another, asked from four places that
 * have nothing else in common (force-advance, enrolment, the phase promotion,
 * and the tick itself). Keeping the two readings in one module is what makes
 * them ONE reading — the operator's door and the next tick must never be able to
 * disagree about whether a cell is stopped.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule lives in `delivery/ramp/`; these are
 * readings of stored rows, and they fail in the direction that cannot raise a
 * share.
 */

import {
	hasCriticalBlocklistSignal,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { loadStreamlessRouteState } from '../lib/deliverabilityRouteState';
import { isSendingAllowed } from '../workspaces/abuseGate';
import { RAMP_MAX_FREEZE_MS } from './ramp/controllerConfig';
import { readActiveFreeze } from './ramp/controllerReaders';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from './deliverabilityRouting';
import type { RampHardStopSignals } from './ramp/controllerTypes';

/**
 * Infrastructure verdicts, read off whichever route-state rows exist.
 *
 * WHICH ROWS MATTER IS NOT THE SAME PER SIGNAL. `breaker_open` is emitted per
 * destination provider, and `applySnapshot` files it onto the STREAMLESS row for
 * that provider — the cell's `streamless` row, not its per-stream one, which is
 * the ramp's own state and carries no MTA signals. Pool-level blocklist
 * and quarantine signals are emitted by the MTA against the WHOLE pool with
 * `provider: 'all'`, and `applySnapshot` files them onto the `'all'` row only —
 * so a controller that read the cell's rows alone would never see one, and the
 * plan's critical-blocklist hard stop would be dead code. Every caller passes
 * the pool row as well.
 *
 * The blocklist test itself is the SHIPPED predicate, not a local copy: one
 * definition of "critically blocklisted" for routing and for the ramp.
 *
 * AND ONE DEFINITION OF "STILL TRUE". The shipped router only acts on a row it
 * has heard from within `DELIVERABILITY_SIGNAL_MAX_AGE_MS` (`routeInputs.ts`),
 * so a snapshot that stopped arriving stops steering traffic. The controller
 * applies the SAME filter: a row the router has already stopped acting on must
 * not still be driving the ramp's breaker and blocklist hard stops. Without it
 * the two layers could disagree about whether a signal counts — and because the
 * breaker rung halves without a floor, a signal that goes stale rather than
 * being cleared would walk the cell toward zero over successive freezes.
 *
 * That filter is only honest because the controller does NOT stamp `updatedAt`
 * (see `applyDecision`): on every row in this scan — the cell's per-stream row
 * included — `updatedAt` means "when a snapshot last wrote this row", exactly
 * what the router means by it. The per-stream row carries no MTA signals today,
 * so in practice `streamless` and `pool` are what answer here; it stays in the
 * list so that a per-stream snapshot writer would be honoured automatically,
 * under the same expiry rule as the router rather than a second one.
 */
export function readHardStopSignals(
	rows: readonly (Doc<'deliverabilityRouteStates'> | null)[],
	args: { readonly isSendingPermitted: boolean; readonly now: number }
): RampHardStopSignals {
	let isCircuitBreakerOpen = false;
	let isPoolBlocklisted = false;
	for (const row of rows) {
		if (row === null) continue;
		if (args.now - row.updatedAt > DELIVERABILITY_SIGNAL_MAX_AGE_MS) continue;
		const { signals } = row;
		if (signals.some((signal) => signal.source === 'breaker_open')) isCircuitBreakerOpen = true;
		if (hasCriticalBlocklistSignal(signals)) isPoolBlocklisted = true;
	}
	return { isSendingAllowed: args.isSendingPermitted, isCircuitBreakerOpen, isPoolBlocklisted };
}

/**
 * IS AN OPERATOR ALLOWED TO RAISE THIS CELL RIGHT NOW?
 *
 * The controls (P3-6) can write a share directly, which means they can reach
 * past the decision function that normally enforces the plan's hard stops. That
 * would make every hard stop optional in exactly the situation it exists for:
 * while the ramp is globally paused for an incident, while the organization is
 * abuse-suspended, while a critical blocklist freeze is running or while the
 * cell is inside a cooldown, an operator could raise the share and the router
 * would read the raised value until the next hourly tick pulled it back.
 *
 * So the mutations ask HERE, through the SAME readers the controller uses —
 * `readHardStopSignals`, the same staleness filter, the same abuse predicate,
 * the same stored freeze — rather than through a second copy of the rules that
 * could drift away from them.
 *
 * ONE-DIRECTIONAL, exactly like the operator's pause and pin. This bounds
 * INCREASES only; a retreat is always permitted, because a safety response an
 * operator cannot reach downward is not a safety response either.
 */
export type RampIncreaseBlock = 'controller_paused' | 'hard_stop_active';

export async function readRampIncreaseBlock(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		/**
		 * `null` when the cell has NO per-stream row yet — the enrolment case. The
		 * deployment-level hard stops still apply (that is the whole point of asking
		 * here), and a row that does not exist carries no stored cooldown to serve.
		 */
		perStream: Doc<'deliverabilityRouteStates'> | null;
		now: number;
	}
): Promise<RampIncreaseBlock | null> {
	const settings = await ctx.db.query('instanceSettings').first();
	// The global kill switch first, and it refuses on its own terms: "everything
	// held still" has to mean everything, including a hand on the control.
	if (settings?.isRampControllerPaused === true) return 'controller_paused';
	const pool = await loadStreamlessRouteState(ctx, args.organizationId, 'all');
	const streamless = await loadStreamlessRouteState(
		ctx,
		args.organizationId,
		args.cell.destinationProvider
	);
	const signals = readHardStopSignals([args.perStream, streamless, pool], {
		isSendingPermitted: isSendingAllowed(settings?.abuseStatus),
		now: args.now,
	});
	if (!signals.isSendingAllowed) return 'hard_stop_active';
	if (signals.isCircuitBreakerOpen) return 'hard_stop_active';
	if (signals.isPoolBlocklisted) return 'hard_stop_active';
	// A cooldown the controller stamped is evidence-bearing state, not a
	// preference: raising through it would discard the retreat that set it.
	//
	// THROUGH THE RUNGS' OWN READER, never an inline `frozenUntil > now`
	// (`controllerReaders.ts` warns against exactly that, and the cron's write
	// path takes the same warning): "is this cell frozen" must mean here what it
	// means to the tick, or an operator could raise a share the controller is
	// about to pull back. Both non-`none` readings block — an UNREADABLE expiry is
	// a row nobody can explain, and a value we cannot read is not permission to
	// climb. That is also the one value an inline comparison gets WRONG rather
	// than merely differently: a non-finite expiry compares false against the
	// clock, so `now < frozenUntil` would call a corrupt row unfrozen and open
	// this door.
	const freeze = readActiveFreeze(args.perStream ?? {}, args.now, RAMP_MAX_FREEZE_MS);
	if (freeze.kind !== 'none') return 'hard_stop_active';
	return null;
}
