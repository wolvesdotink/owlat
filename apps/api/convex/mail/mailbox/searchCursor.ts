/**
 * Keyset cursor + merge arithmetic for a search that spans SEVERAL mailboxes.
 *
 * Convex allows exactly one `.paginate()` per function execution, so a search
 * over N mailboxes cannot paginate each one natively — it walks every mailbox
 * with a MANUAL keyset (`by_mailbox_and_received`, descending) and carries one
 * position per mailbox in a single opaque cursor string.
 *
 * A position is `receivedAt` PLUS a count, never `receivedAt` alone: the index
 * range API cannot express a `(receivedAt, _id)` compound bound, so resuming
 * re-reads the boundary timestamp's whole tie group and the count says how many
 * of those rows were already handed out. Counting (rather than remembering the
 * last row id) is what makes a tie group longer than one page terminate — an
 * id-only position re-reads the same prefix forever once the tie group outgrows
 * the page.
 *
 * Everything here is pure so the codec and the advance rules are unit-testable
 * without a Convex isolate (`mail/__tests__/searchCursor.test.ts`); the Convex
 * side (`mail/mailbox/search.ts`) only does the reads.
 *
 * The rules the merge upholds:
 *   - the returned page is the newest `limit` rows across all mailboxes, so
 *     ordering is by `receivedAt` (descending), never by mailbox;
 *   - a mailbox's position only advances past rows the caller was actually
 *     handed, or past rows the post-filter rejected — a row is never skipped;
 *   - a mailbox absent from the cursor is EXHAUSTED, and a mailbox present with
 *     a `null` position has not been scanned past its newest row yet.
 */

/**
 * One mailbox's resume point: `skip` rows at timestamp `at` have been consumed.
 * The next page re-reads from `receivedAt <= at` and drops that many.
 */
export interface MailboxScanPosition {
	/** `receivedAt` of the last consumed row. */
	at: number;
	/** How many rows AT that timestamp are already consumed (1-based count). */
	skip: number;
}

/**
 * Per-mailbox scan state carried across pages.
 *
 * Presence is meaningful: a mailbox key that is ABSENT is exhausted and is not
 * scanned again; a key mapped to `null` is "start from the newest row".
 */
export type MultiSearchCursor = Record<string, MailboxScanPosition | null>;

/** Version tag, so a cursor minted by an older deployment is rejected rather than misread. */
const CURSOR_VERSION = 1;

/** Encode per-mailbox positions into the single opaque cursor string. */
export function encodeMultiCursor(cursor: MultiSearchCursor): string {
	const positions: Record<string, [number, number] | null> = {};
	for (const [mailboxId, position] of Object.entries(cursor)) {
		positions[mailboxId] = position ? [position.at, position.skip] : null;
	}
	return JSON.stringify({ v: CURSOR_VERSION, p: positions });
}

/**
 * Decode a cursor string. `undefined` (first page) and anything unparseable or
 * from another cursor version decode to `null`, which the caller reads as "scan
 * every target mailbox from its newest row" — a fresh first page, never a
 * silently truncated one.
 */
export function decodeMultiCursor(raw: string | undefined | null): MultiSearchCursor | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const envelope = parsed as { v?: unknown; p?: unknown };
	if (envelope.v !== CURSOR_VERSION) return null;
	if (typeof envelope.p !== 'object' || envelope.p === null) return null;
	const cursor: MultiSearchCursor = {};
	for (const [mailboxId, value] of Object.entries(envelope.p as Record<string, unknown>)) {
		if (value === null) {
			cursor[mailboxId] = null;
			continue;
		}
		if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
			return null;
		}
		cursor[mailboxId] = { at: value[0], skip: value[1] };
	}
	return cursor;
}

/** The row shape the merge needs — every `mailMessages` doc satisfies it. */
export interface ScannedRow {
	_id: string;
	mailboxId: string;
	receivedAt: number;
}

/** A scanned row paired with the position it occupies in its mailbox's walk. */
export interface PositionedRow<T extends ScannedRow> {
	row: T;
	position: MailboxScanPosition;
}

/**
 * Pair every row of one descending mailbox scan with its position: the row's
 * timestamp plus its 1-based rank among the rows that share that timestamp.
 *
 * The rank is counted over the RAW page, which always starts at the first row
 * of the boundary tie group (the range bound is `receivedAt <= at`), so ranks
 * are stable across pages. Pure.
 */
export function positionRows<T extends ScannedRow>(rows: readonly T[]): PositionedRow<T>[] {
	const positioned: PositionedRow<T>[] = [];
	let currentAt: number | null = null;
	let rank = 0;
	for (const row of rows) {
		if (row.receivedAt !== currentAt) {
			currentAt = row.receivedAt;
			rank = 0;
		}
		rank += 1;
		positioned.push({ row, position: { at: row.receivedAt, skip: rank } });
	}
	return positioned;
}

/**
 * Was this row already handed out on an earlier page? True for the rows of the
 * boundary tie group up to the recorded count. Rows at an older timestamp are
 * never consumed (the walk only ever moves backwards in time). Pure.
 */
export function isConsumed(
	position: MailboxScanPosition,
	previous: MailboxScanPosition | null | undefined
): boolean {
	if (!previous) return false;
	return position.at === previous.at && position.skip <= previous.skip;
}

/** One mailbox's contribution to the page being assembled. */
export interface MailboxPage<T extends ScannedRow> {
	mailboxId: string;
	/** Where this mailbox stood when the page started (`null` = at its newest row). */
	previous?: MailboxScanPosition | null;
	/** Post-filtered rows for this mailbox, newest first, each with its position. */
	rows: readonly PositionedRow<T>[];
	/**
	 * Position of the last row the raw scan READ (before the post-filter), or
	 * undefined when nothing was read. Rows the post-filter rejected are
	 * consumed, not skipped, so the position may advance past them.
	 */
	scanned?: MailboxScanPosition;
	/** True when the raw scan reached the end of this mailbox's rows. */
	done: boolean;
}

/** The assembled page plus the cursor state that continues it. */
export interface MergedSearchPage<T extends ScannedRow> {
	page: T[];
	cursor: MultiSearchCursor;
	hasMore: boolean;
}

/** Descending by `receivedAt`, then by `_id` so equal timestamps have a total order. */
function newestFirst<T extends ScannedRow>(
	left: PositionedRow<T>,
	right: PositionedRow<T>
): number {
	if (left.row.receivedAt !== right.row.receivedAt)
		return right.row.receivedAt - left.row.receivedAt;
	return left.row._id < right.row._id ? 1 : left.row._id > right.row._id ? -1 : 0;
}

/**
 * Merge per-mailbox pages into one `receivedAt`-ordered page and compute the
 * continuation cursor.
 *
 * A mailbox advances to the last row the scan READ only when every one of its
 * post-filtered rows made it into the page; when the `limit` cut some of them
 * off, it advances only across the unbroken run of rows that were actually
 * handed over, so the remainder is re-read on the next page instead of being
 * lost. A mailbox that contributed nothing and was not exhausted keeps its
 * previous position. Pure.
 */
export function mergeMailboxPages<T extends ScannedRow>(
	pages: readonly MailboxPage<T>[],
	limit: number
): MergedSearchPage<T> {
	const merged = pages
		.flatMap((mailboxPage) => mailboxPage.rows.slice())
		.sort(newestFirst)
		.slice(0, Math.max(0, limit));
	const emitted = new Set(merged.map((entry) => entry.row._id));

	const cursor: MultiSearchCursor = {};
	for (const mailboxPage of pages) {
		// Advance only across the UNBROKEN run of emitted rows: the first row the
		// `limit` cut off is where this mailbox resumes, so nothing behind it can
		// be stepped over even if the merge order disagrees with the scan order
		// inside a `receivedAt` tie.
		let boundary = -1;
		for (const [index, entry] of mailboxPage.rows.entries()) {
			if (!emitted.has(entry.row._id)) break;
			boundary = index;
		}
		const truncated = boundary < mailboxPage.rows.length - 1;
		if (!truncated && mailboxPage.done) continue; // exhausted → leave it out
		const lastEmitted = boundary >= 0 ? mailboxPage.rows[boundary] : undefined;
		cursor[mailboxPage.mailboxId] = truncated
			? (lastEmitted?.position ?? mailboxPage.previous ?? null)
			: (mailboxPage.scanned ?? mailboxPage.previous ?? null);
	}

	return {
		page: merged.map((entry) => entry.row),
		cursor,
		hasMore: Object.keys(cursor).length > 0,
	};
}
