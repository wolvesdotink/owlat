/**
 * Freshness arbitration shared by every external-reputation ingest path
 * (Google Postmaster, Microsoft SNDS).
 *
 * All of them poll a provider on a schedule and write one row per subject per
 * UTC day, so all of them face the same three cases: a newer read wins, an
 * identical read is a replay to acknowledge without writing, and an older read
 * is a late-arriving duplicate that must not overwrite fresher data.
 */
export type ObservationVerdict = 'stale' | 'replayed' | 'write';

/** What to do with an observation given what is already stored for its day. */
export function observationVerdict(
	storedFetchedAt: number | undefined,
	fetchedAt: number
): ObservationVerdict {
	if (storedFetchedAt === undefined || storedFetchedAt < fetchedAt) return 'write';
	return storedFetchedAt === fetchedAt ? 'replayed' : 'stale';
}
