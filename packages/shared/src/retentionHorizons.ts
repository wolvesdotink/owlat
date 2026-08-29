/**
 * How long Owlat keeps things, in days, as ONE set of numbers.
 *
 * The "Your data" card (idea 67) states these horizons to the user in plain
 * words, and the sweeps in `apps/api/convex/delivery/checklistRetention.ts`
 * enforce them. Before this module the numbers lived only in the sweep, so any
 * card that quoted them was a copy waiting to go stale — and a retention promise
 * that no longer matches what the deployment does is worse than no promise.
 *
 * Days rather than milliseconds because that is the unit the copy uses; the
 * sweeps multiply by {@link RETENTION_DAY_MS}.
 */

export const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Deliverability observations (`deliverabilityEvidence`). The current
 * observation for each check, and any observation an unresolved incident points
 * at, are kept regardless of age — this is the horizon for the superseded rest.
 */
export const DELIVERABILITY_EVIDENCE_RETENTION_DAYS = 90;

/**
 * Terminal deliverability records: resolved regression incidents and completed
 * loopback probes. Shorter, because neither is part of the live checklist state.
 */
export const DELIVERABILITY_COMPLETED_RETENTION_DAYS = 30;
