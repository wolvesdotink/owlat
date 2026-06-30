/**
 * Keyset pagination over `(receivedAt asc, _id asc)` with exact same-timestamp
 * draining.
 *
 * Imported mail history routinely has many rows sharing one `receivedAt`
 * (RFC 5322 `Date:` is second-precision; dateless mail falls back to the
 * import-time clock), so a continuation cannot step past the cursor's
 * timestamp with a fixed over-fetch — a same-timestamp group larger than the
 * page would fill the window, wedge the walk, and silently drop the rest of
 * the table. Instead: (1) drain the remainder of the cursor's exact-timestamp
 * group (`eq(receivedAt)`, `_id`-filtered), then (2) pull strictly-newer rows
 * until `limit + 1` (the +1 probes `hasMore`).
 *
 * This bug was found and fixed twice — once in mail/migrationIndexing and
 * again in agent/knowledgeBackfill — because the walker was copy-pasted.
 * Both call sites now share this implementation; they only provide the three
 * index reads for their own table.
 */
export interface ReceivedAtCursorPage<T> {
	rows: T[];
	hasMore: boolean;
}

export async function takeReceivedAtChunk<T extends { _id: string; receivedAt: number }>(opts: {
	limit: number;
	cursorReceivedAt?: number;
	cursorId?: string;
	/** First `take` rows ordered by (receivedAt asc, _id asc). */
	firstPage: (take: number) => Promise<T[]>;
	/** ALL rows with exactly this receivedAt (bounded: one exact millisecond). */
	sameTimestamp: (receivedAt: number) => Promise<T[]>;
	/** First `take` rows with receivedAt strictly greater, ordered asc. */
	newer: (receivedAt: number, take: number) => Promise<T[]>;
}): Promise<ReceivedAtCursorPage<T>> {
	const { limit, cursorReceivedAt, cursorId } = opts;

	// First page — smallest receivedAt forward.
	if (cursorReceivedAt === undefined) {
		const rows = await opts.firstPage(limit + 1);
		const hasMore = rows.length > limit;
		return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
	}

	// Continuation — drain the cursor's exact-timestamp group first.
	const sameTs = await opts.sameTimestamp(cursorReceivedAt);
	const collected: T[] = sameTs
		.filter((m) => cursorId === undefined || m._id > cursorId)
		.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));

	if (collected.length <= limit) {
		collected.push(...(await opts.newer(cursorReceivedAt, limit + 1 - collected.length)));
	}

	const hasMore = collected.length > limit;
	return { rows: hasMore ? collected.slice(0, limit) : collected, hasMore };
}
