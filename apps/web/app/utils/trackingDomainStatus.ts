/**
 * What a tracking-domain row shows: its status badge, and the message from its
 * last check when that check did not pass. The backend records which half of
 * the check failed (`domains/trackingDomainVerdict.ts`); this maps it to copy
 * that says what the operator has to fix.
 */

export type TrackingDomainCheckOutcome =
	| 'verified'
	| 'dns_mismatch'
	| 'https_unreachable'
	| 'https_wrong_response'
	| 'inconclusive';

export interface TrackingDomainRow {
	readonly isVerified: boolean;
	readonly verifiedAt?: number;
	readonly regressionSuspectedAt?: number;
	readonly lastCheck?: { readonly at: number; readonly outcome: TrackingDomainCheckOutcome };
}

/**
 * - `verified`: links in new campaigns use the domain.
 * - `failing`: still used, but its last check failed; a confirming check is due.
 * - `lapsed`: was verified, stopped working; new campaigns use the default host.
 * - `pending`: never verified yet.
 */
export type TrackingDomainStatus = 'verified' | 'failing' | 'lapsed' | 'pending';

export function trackingDomainStatus(row: TrackingDomainRow): TrackingDomainStatus {
	if (row.isVerified) return row.regressionSuspectedAt === undefined ? 'verified' : 'failing';
	return row.verifiedAt === undefined ? 'pending' : 'lapsed';
}

const CHECK_MESSAGE_KEYS: Record<Exclude<TrackingDomainCheckOutcome, 'verified'>, string> = {
	dns_mismatch: 'components.domains.trackingDomainsSection.lastCheck.dnsMismatch',
	https_unreachable: 'components.domains.trackingDomainsSection.lastCheck.httpsUnreachable',
	https_wrong_response: 'components.domains.trackingDomainsSection.lastCheck.httpsWrongResponse',
	inconclusive: 'components.domains.trackingDomainsSection.lastCheck.inconclusive',
};

/** The catalog key explaining the last check, or `null` when it passed or never ran. */
export function trackingDomainCheckMessageKey(row: TrackingDomainRow): string | null {
	const outcome = row.lastCheck?.outcome;
	if (outcome === undefined || outcome === 'verified') return null;
	return CHECK_MESSAGE_KEYS[outcome];
}
