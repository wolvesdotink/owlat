/**
 * The ramp controller's capacity projection — deliberately NARROW, and
 * deliberately NOT IMPLEMENTED HERE.
 *
 * The plan's formula is per CELL on both sides: `warmingCapRemaining(cell) /
 * projectedVolume(cell)`. P3-3 owns that projection, because it owns the
 * per-(IP x mailbox provider) warming model the numerator has to come from.
 * Until it lands, this module hands the controller an explicitly UNCONSTRAINED
 * projection and the share is bounded by its PHASE CEILING alone.
 *
 * WHY NOT SHIP A STAND-IN. The obvious approximation — the deployment-wide
 * remaining warming headroom over one cell's trailing volume — is wrong in both
 * directions. The numerator is shared by all fifteen cells, so each one claims
 * the whole deployment's headroom and the ceiling is far LOOSER than the plan
 * intends; and as the day's sends approach the cap that numerator decays toward
 * zero against a trailing-24h denominator that does not, so the ceiling
 * collapses and retreats cells whose gates are all green — a daily sawtooth
 * into the relay, with an admin notice attached to each one. A ceiling nobody
 * designed is worse than no ceiling at all.
 *
 * ABSENCE IS NOT A CONSTRAINT (plan D2). A missing external reading is never
 * evidence of a full cap.
 */

import type { RampCapacityInput } from './ramp/controllerTypes';

/**
 * The "no capacity constraint" projection: zero projected volume bounds
 * nothing (`capacityCeiling` maps it to the full ceiling, not to zero).
 */
export const UNCONSTRAINED_RAMP_CAPACITY: RampCapacityInput = {
	warmingCapRemaining: 0,
	projectedVolume: 0,
};
