/**
 * The team stream's paging rules (SPEC §7 "Team"), pure.
 *
 * A team thread is read as one stream: customer emails, the team's replies,
 * internal notes and activity system lines, in one order with keys that stay
 * the same across pages. Each source is read on its own (its own table and
 * index) and the pieces are merged here.
 *
 * A position is `(at, tie, key)`, ascending, and it is exactly the order the
 * source's index serves its rows in: `at` is the index's time field, `tie` the
 * row's `_creationTime` (every Convex index ends in it) and `key` (`<kind>:<id>`)
 * only separates rows the index itself cannot tell apart. A source reads its
 * index newest first from the cursor down (`rangesBefore`: the rows with the
 * cursor's own `at` from its `tie` down, then every older `at`), so a page
 * boundary inside a run of equal timestamps never skips a row.
 *
 * Paging walks backwards: the first page is the newest one, and its cursor
 * names the oldest position it covers. Every source reads strictly before
 * that position. A source that stopped early (it hit its page size or its
 * scan budget) reports a `floor`, the oldest row it has looked at: it may hold
 * more entries below it, so nothing from another source below the highest
 * floor can go on this page, or the next page would have to insert entries in
 * the middle of one already shown. Nothing is capped: every source continues
 * from the cursor until it is exhausted.
 *
 * Isolate-safe, no Convex functions.
 */

/** A place in the stream. */
export interface StreamPosition {
	at: number;
	/** The row's `_creationTime`: the index's own order among equal `at`. */
	tie: number;
	key: string;
}

/** Ascending stream order. */
export function compareStreamPositions(a: StreamPosition, b: StreamPosition): number {
	if (a.at !== b.at) return a.at - b.at;
	if (a.tie !== b.tie) return a.tie - b.tie;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Whether `a` comes before (is older than) `b` in the stream. */
export function isBefore(a: StreamPosition, b: StreamPosition): boolean {
	return compareStreamPositions(a, b) < 0;
}

/** The opaque cursor of a position: `<at>|<tie>|<key>`. */
export function encodeStreamCursor(position: StreamPosition): string {
	return `${position.at}|${position.tie}|${position.key}`;
}

/** The position a cursor names, or null for a cursor this module did not write. */
export function decodeStreamCursor(cursor: string | null | undefined): StreamPosition | null {
	if (!cursor) return null;
	const [atText, tieText, ...rest] = cursor.split('|');
	const at = Number(atText);
	const tie = Number(tieText);
	const key = rest.join('|');
	if (!atText || !tieText || !Number.isFinite(at) || !Number.isFinite(tie) || !key) return null;
	return { at, tie, key };
}

/** Whether an entry belongs on a page that ends before `before`. */
export function isOnPage(position: StreamPosition, before: StreamPosition | null): boolean {
	return before === null || isBefore(position, before);
}

/** What one source read for a page. */
export interface SourceBatch<E extends StreamPosition> {
	/** Its entries strictly before the cursor, in any order. */
	entries: E[];
	/**
	 * The oldest row position the source looked at when it stopped early (page
	 * size or scan budget reached); null when it read everything it holds
	 * before the cursor.
	 */
	floor: StreamPosition | null;
}

export interface MergedPage<E extends StreamPosition> {
	/** Oldest first, the order the stream is shown in. */
	entries: E[];
	/** Where the next (older) page starts; null when nothing older exists. */
	cursor: string | null;
	isDone: boolean;
}

/**
 * Merge the sources' batches into one page of at most `limit` entries: the
 * newest entries that every source can vouch for.
 */
export function mergeStreamPage<E extends StreamPosition>(
	batches: readonly SourceBatch<E>[],
	limit: number
): MergedPage<E> {
	let floor: StreamPosition | null = null;
	for (const batch of batches) {
		if (batch.floor && (floor === null || isBefore(floor, batch.floor))) floor = batch.floor;
	}
	const newestFirst = batches
		.flatMap((batch) => batch.entries)
		.sort((a, b) => compareStreamPositions(b, a))
		.filter((entry) => floor === null || !isBefore(entry, floor));
	const page = newestFirst.slice(0, limit);
	const isCut = newestFirst.length > limit;
	if (!isCut && floor === null) return { entries: page.reverse(), cursor: null, isDone: true };
	const oldest = page[page.length - 1];
	const boundary: StreamPosition = isCut && oldest ? oldest : (floor ?? oldest!);
	return {
		entries: page.reverse(),
		cursor: encodeStreamCursor({ at: boundary.at, tie: boundary.tie, key: boundary.key }),
		isDone: false,
	};
}

/** Several index ranges read one after the other (newest range first). */
export async function* chainRanges<R>(ranges: readonly AsyncIterable<R>[]): AsyncIterable<R> {
	for (const range of ranges) yield* range;
}

/**
 * The index ranges a source reads below `before`, newest first: the rows with
 * the cursor's own `at` from its `tie` down, then every older `at`. `tied` and
 * `older` build the two index queries (descending); without a cursor, `all`.
 */
export function rangesBefore<R>(
	before: StreamPosition | null,
	queries: {
		all: () => AsyncIterable<R>;
		tied: (at: number, tie: number) => AsyncIterable<R>;
		older: (at: number) => AsyncIterable<R>;
	}
): AsyncIterable<R> {
	if (!before) return queries.all();
	return chainRanges([queries.tied(before.at, before.tie), queries.older(before.at)]);
}

/**
 * Read one source newest first: rows strictly before `before`, until `limit`
 * entries are kept or `budget` rows were looked at. A row yields zero or more
 * entries (a customer email and the legacy reply shown with it); entries at or
 * after the cursor are left out, the rest are kept. A row that yields nothing
 * still counts against the budget and moves the floor.
 */
export async function readSourceBatch<R, E extends StreamPosition>(
	rows: AsyncIterable<R>,
	opts: {
		before: StreamPosition | null;
		limit: number;
		budget: number;
		positionOf: (row: R) => StreamPosition;
		toEntries: (row: R) => Promise<E[]> | E[];
	}
): Promise<SourceBatch<E>> {
	const entries: E[] = [];
	let scanned = 0;
	for await (const row of rows) {
		const position = opts.positionOf(row);
		if (!isOnPage(position, opts.before)) continue;
		scanned++;
		for (const entry of await opts.toEntries(row)) {
			if (isOnPage(entry, opts.before)) entries.push(entry);
		}
		if (entries.length >= opts.limit || scanned >= opts.budget) {
			return { entries, floor: position };
		}
	}
	return { entries, floor: null };
}

/**
 * Activity rows the stream shows as system lines: substance only, and not
 * the ones a bubble already shows (an email arriving, a reply going out).
 */
const BUBBLE_ACTIVITY = new Set(['message_received', 'reply_sent', 'auto_sent']);

export function isStreamActivity(row: { type: string; visibility: string }): boolean {
	return row.visibility === 'substance' && !BUBBLE_ACTIVITY.has(row.type);
}

/** A Send's status as the stream shows a team reply. */
export function teamReplyStatusOf(status: string): 'queued' | 'sent' | 'failed' {
	if (status === 'queued') return 'queued';
	if (status === 'failed' || status === 'bounced') return 'failed';
	return 'sent';
}

/** A Postbox outbound row's recipients as one status. */
export function outboundStatusOf(
	recipients: readonly { state: 'queued' | 'sent' | 'bounced' | 'failed' }[]
): 'queued' | 'sent' | 'failed' {
	if (recipients.some((r) => r.state === 'bounced' || r.state === 'failed')) return 'failed';
	if (recipients.some((r) => r.state === 'queued')) return 'queued';
	return 'sent';
}

/** A short single-line preview of raw text. */
export function streamPreview(text: string | undefined, max = 280): string {
	const flat = (text ?? '').replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;
	return `${[...flat].slice(0, max - 1).join('')}…`;
}
