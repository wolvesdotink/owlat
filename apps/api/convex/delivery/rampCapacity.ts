/**
 * The ramp controller's capacity projection — deliberately NARROW.
 *
 * P3-3 owns the real per-(IP x mailbox provider) projection. This module is the
 * seam it will replace: two numbers, one function, no controller code to touch.
 * Until then the projection is derived from SHIPPED data only — the warming
 * state the MTA already syncs, and the cell's own recent send volume from
 * `transportOutcomes` — so the controller has a real ceiling rather than a
 * placeholder that quietly disables it.
 *
 * ABSENCE IS NOT A CONSTRAINT (plan D2). A deployment whose MTA has never
 * reported warming state has no warming ceiling to respect, so the projection
 * reports "nothing to bound" and the cell is limited by its phase ceiling
 * alone. It must never report an error, and it must never report zero capacity
 * — a missing external reading is not evidence of a full cap.
 */

import type { DeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import type { DatabaseReader } from '../_generated/server';
import { summarizeTransportOutcomeArms } from '../analytics/transportOutcomes';
import type { RampCapacityInput } from './ramp/controllerTypes';

/** How far back the volume projection looks. One day of real sending. */
export const RAMP_PROJECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The "no capacity constraint" projection: zero projected volume bounds nothing. */
export const UNCONSTRAINED_RAMP_CAPACITY: RampCapacityInput = {
	warmingCapRemaining: 0,
	projectedVolume: 0,
};

function nonNegative(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
	return value;
}

/**
 * Remaining warming headroom and the cell's projected volume for the window.
 *
 * The warming cap is deployment-wide (the MTA reports a total across campaign
 * IPs), while the volume is per cell — which is the CONSERVATIVE pairing: a
 * cell is never told it may claim more headroom than the deployment has left.
 */
export async function loadRampCapacity(
	db: DatabaseReader,
	args: { organizationId: string; cell: DeliverabilityCellKey; now: number }
): Promise<RampCapacityInput> {
	const warming = await db.query('warmingState').first();
	if (!warming) return UNCONSTRAINED_RAMP_CAPACITY;

	const warmingCapRemaining = Math.max(
		0,
		nonNegative(warming.totalDailyCap) - nonNegative(warming.totalSentToday)
	);

	const since = Number.isFinite(args.now) ? args.now - RAMP_PROJECTION_WINDOW_MS : 0;
	const { own, reference } = await summarizeTransportOutcomeArms(db, {
		organizationId: args.organizationId,
		cell: args.cell,
		since,
	});
	// BOTH arms: the projection is what the CELL will send next window, not what
	// the own MTA sent last one. Projecting from the own arm alone would let a
	// cell at 5% share claim the whole remaining cap.
	const projectedVolume = nonNegative(own.sent) + nonNegative(reference.sent);

	return { warmingCapRemaining, projectedVolume };
}
