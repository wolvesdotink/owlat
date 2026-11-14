/**
 * How long a soft-bounce suppression lasts, for both systems that keep one:
 * the Convex blocklist (`blockedEmails`, read by every send path) and the MTA's
 * Redis suppression list it mirrors to. A full or temporarily unavailable
 * mailbox recovers; a hard bounce, a complaint or a manual block does not
 * expire. If the two systems disagreed, an address would be blocked by one and
 * sendable by the other.
 */
export const SOFT_BOUNCE_SUPPRESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The blocklist fields the expiry rule reads. */
interface SuppressionRow {
	reason: string;
	bounceType?: 'hard' | 'soft' | undefined;
	createdAt: number;
}

/** When a suppression stops blocking, or `null` for one that never expires. */
export function suppressionExpiresAt(row: SuppressionRow): number | null {
	return row.reason === 'bounced' && row.bounceType === 'soft'
		? row.createdAt + SOFT_BOUNCE_SUPPRESSION_TTL_MS
		: null;
}

/** Whether a suppression has expired at `now` and no longer blocks. */
export function isSuppressionExpired(row: SuppressionRow, now: number): boolean {
	const expiresAt = suppressionExpiresAt(row);
	return expiresAt !== null && expiresAt <= now;
}
