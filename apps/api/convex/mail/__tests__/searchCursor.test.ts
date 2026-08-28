/**
 * Keyset arithmetic for the multi-mailbox search fan-out
 * (`mail/mailbox/searchCursor.ts`).
 *
 * The fan-out cannot use Convex's native pagination (one `.paginate()` per
 * function execution), so this module IS the pagination: if it advances a
 * mailbox too far a message becomes unreachable, and if it advances too little
 * "Load more" loops on the same page forever. Both directions are pinned here,
 * without a Convex isolate.
 */
import { describe, it, expect } from 'vitest';
import {
	type MailboxPage,
	type ScannedRow,
	decodeMultiCursor,
	encodeMultiCursor,
	isConsumed,
	mergeMailboxPages,
	positionRows,
} from '../mailbox/searchCursor';

function row(id: string, mailboxId: string, receivedAt: number): ScannedRow {
	return { _id: id, mailboxId, receivedAt };
}

function page(overrides: Partial<MailboxPage<ScannedRow>> = {}): MailboxPage<ScannedRow> {
	return { mailboxId: 'mb1', rows: [], done: false, ...overrides };
}

/** Positioned rows for one mailbox, as the scan would hand them to the merge. */
function scan(mailboxId: string, rows: Array<[string, number]>) {
	return positionRows(rows.map(([id, at]) => row(id, mailboxId, at)));
}

describe('encodeMultiCursor / decodeMultiCursor', () => {
	it('round-trips positions and the "not yet scanned" null', () => {
		const cursor = { mb1: { at: 1_700, skip: 2 }, mb2: null };
		expect(decodeMultiCursor(encodeMultiCursor(cursor))).toEqual(cursor);
	});

	it('reads an absent cursor as a fresh first page', () => {
		expect(decodeMultiCursor(undefined)).toBeNull();
		expect(decodeMultiCursor('')).toBeNull();
	});

	it('rejects garbage and foreign versions instead of misreading them', () => {
		expect(decodeMultiCursor('not json')).toBeNull();
		expect(decodeMultiCursor(JSON.stringify({ v: 99, p: {} }))).toBeNull();
		expect(decodeMultiCursor(JSON.stringify({ v: 1, p: { mb1: ['nope'] } }))).toBeNull();
	});
});

describe('positionRows / isConsumed', () => {
	it('ranks rows within each timestamp, restarting at every new timestamp', () => {
		const positioned = scan('mb1', [
			['c', 300],
			['b', 200],
			['a', 200],
			['z', 100],
		]);
		expect(positioned.map((entry) => entry.position)).toEqual([
			{ at: 300, skip: 1 },
			{ at: 200, skip: 1 },
			{ at: 200, skip: 2 },
			{ at: 100, skip: 1 },
		]);
	});

	it('consumes exactly the recorded prefix of the boundary tie group', () => {
		const positioned = scan('mb1', [
			['b', 200],
			['a', 200],
			['z', 100],
		]);
		const previous = { at: 200, skip: 1 };
		expect(
			positioned.filter((entry) => !isConsumed(entry.position, previous)).map((e) => e.row._id)
		).toEqual(['a', 'z']);
	});

	it('consumes nothing without a previous position', () => {
		const positioned = scan('mb1', [['b', 200]]);
		expect(isConsumed(positioned[0]!.position, null)).toBe(false);
	});
});

describe('mergeMailboxPages', () => {
	it('orders the merged page newest-first across mailboxes', () => {
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [
						['a', 300],
						['c', 100],
					]),
					done: true,
				}),
				page({ mailboxId: 'mb2', rows: scan('mb2', [['b', 200]]), done: true }),
			],
			10
		);
		expect(merged.page.map((r) => r._id)).toEqual(['a', 'b', 'c']);
		expect(merged.hasMore).toBe(false);
		expect(merged.cursor).toEqual({});
	});

	it('caps the page at the limit and resumes each mailbox at its last handed-out row', () => {
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [
						['a', 300],
						['c', 100],
					]),
					scanned: { at: 100, skip: 1 },
				}),
				page({
					mailboxId: 'mb2',
					rows: scan('mb2', [
						['b', 200],
						['d', 50],
					]),
					scanned: { at: 50, skip: 1 },
				}),
			],
			2
		);
		expect(merged.page.map((r) => r._id)).toEqual(['a', 'b']);
		expect(merged.hasMore).toBe(true);
		// Each mailbox resumes exactly after the row the caller actually got, so
		// the truncated rows come back on the next page.
		expect(merged.cursor).toEqual({
			mb1: { at: 300, skip: 1 },
			mb2: { at: 200, skip: 1 },
		});
	});

	it('advances past rows the post-filter rejected when nothing was truncated', () => {
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [['a', 300]]),
					// The raw scan read further than the surviving row.
					scanned: { at: 10, skip: 3 },
				}),
			],
			10
		);
		expect(merged.cursor).toEqual({ mb1: { at: 10, skip: 3 } });
	});

	it('keeps a starved mailbox at its previous position instead of dropping it', () => {
		const merged = mergeMailboxPages(
			[
				page({ mailboxId: 'mb1', rows: scan('mb1', [['a', 300]]), scanned: { at: 300, skip: 1 } }),
				page({
					mailboxId: 'mb2',
					previous: { at: 900, skip: 4 },
					rows: scan('mb2', [['b', 200]]),
					scanned: { at: 200, skip: 1 },
				}),
			],
			1
		);
		expect(merged.page.map((r) => r._id)).toEqual(['a']);
		expect(merged.cursor).toEqual({
			mb1: { at: 300, skip: 1 },
			mb2: { at: 900, skip: 4 },
		});
	});

	it('drops an exhausted mailbox from the cursor and reports hasMore from the rest', () => {
		const merged = mergeMailboxPages(
			[
				page({ mailboxId: 'mb1', rows: scan('mb1', [['a', 300]]), done: true }),
				page({ mailboxId: 'mb2', rows: scan('mb2', [['b', 200]]), scanned: { at: 200, skip: 1 } }),
			],
			10
		);
		expect(merged.cursor).toEqual({ mb2: { at: 200, skip: 1 } });
		expect(merged.hasMore).toBe(true);
	});

	it('drops a truncated page that has no keyset position instead of repeating it', () => {
		// The free-text branch reads the relevance-ordered search index: it reports
		// `done` and carries no `scanned` position. Giving it a resume position
		// would re-read the same relevance page and hand `h2` out twice, so the
		// mailbox leaves the cursor and stays one page — the recorded deferral.
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [
						['h1', 300],
						['h2', 100],
					]),
					done: true,
				}),
				page({ mailboxId: 'mb2', rows: scan('mb2', [['b1', 400]]), done: true }),
			],
			2
		);
		expect(merged.page.map((r) => r._id)).toEqual(['b1', 'h1']);
		expect(merged.cursor).toEqual({});
		expect(merged.hasMore).toBe(false);
	});

	it('still resumes a truncated keyset page that read rows', () => {
		// The guard above keys on the MISSING position, not on `done`: a keyset
		// scan that hit the end of its mailbox mid-page must still come back for
		// the rows the limit cut off.
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [
						['a', 300],
						['b', 100],
					]),
					scanned: { at: 100, skip: 1 },
					done: true,
				}),
			],
			1
		);
		expect(merged.page.map((r) => r._id)).toEqual(['a']);
		expect(merged.cursor).toEqual({ mb1: { at: 300, skip: 1 } });
	});

	it('never steps over a gap when the limit cuts inside a receivedAt tie', () => {
		// Both rows share a timestamp; the merge tie-break hands out `y` (higher
		// `_id`) first, but the scan order was x, y — so the cursor must stop
		// BEFORE x rather than skipping it.
		const merged = mergeMailboxPages(
			[
				page({
					mailboxId: 'mb1',
					rows: scan('mb1', [
						['x', 200],
						['y', 200],
					]),
				}),
			],
			1
		);
		expect(merged.page.map((r) => r._id)).toEqual(['y']);
		expect(merged.cursor).toEqual({ mb1: null });
	});
});
