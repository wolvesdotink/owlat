/**
 * Deliverability reputation rate thresholds — the single source of truth shared
 * by the Convex backend's risk classification (`analytics/sendingReputation.ts`)
 * and the web reputation UI (`OrgReputationCard`, `DomainReputationTable`).
 *
 * A bounce/complaint rate (as a fraction of total sends) at or above each
 * boundary escalates the risk level. Industry context: Gmail/Yahoo reject above
 * ~0.3% complaints; major ESPs warn above ~2% bounces.
 */
export const REPUTATION_THRESHOLDS = {
	bounce: { medium: 0.02, high: 0.05, critical: 0.1 },
	complaint: { medium: 0.001, high: 0.002, critical: 0.003 },
} as const;

/** Minimum sends before reputation enforcement kicks in (avoid penalizing tiny senders). */
export const REPUTATION_MIN_SAMPLE_SIZE = 100;
