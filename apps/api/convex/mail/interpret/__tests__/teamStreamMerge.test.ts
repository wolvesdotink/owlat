/**
 * The team stream's paging rules (teamStreamMerge.ts): one order across
 * sources that is exactly each index's order (`at`, then `_creationTime`),
 * stable cursors, and pages that never skip or repeat an entry, also inside
 * runs of equal timestamps whose keys disagree with the index order, when a
 * row yields several entries, and when a source stops early on its budget.
 */

import { describe, expect, it } from 'vitest';
import {
	compareStreamPositions,
	decodeStreamCursor,
	encodeStreamCursor,
	isStreamActivity,
	mergeStreamPage,
	outboundStatusOf,
	rangesBefore,
	readSourceBatch,
	streamPreview,
	teamReplyStatusOf,
	type StreamPosition,
} from '../teamStreamMerge';

/** A stored row: the index's time field and its `_creationTime`. */
interface Row {
	id: string;
	at: number;
	creation: number;
	isHidden?: boolean;
	/** Extra entries the row yields after itself (a legacy reply under its email). */
	children?: number;
}

async function* iterate<T>(rows: readonly T[]): AsyncIterable<T> {
	for (const row of rows) yield row;
}

/**
 * The index as Convex serves it: `(at, _creationTime)` descending, nothing
 * else. Ids are deliberately NOT in that order.
 */
function indexDesc(rows: readonly Row[], keep: (row: Row) => boolean) {
	return iterate(rows.filter(keep).sort((a, b) => b.at - a.at || b.creation - a.creation));
}

function source(prefix: string, rows: readonly Row[], opts: { limit: number; budget: number }) {
	const positionOf = (row: Row): StreamPosition => ({
		at: row.at,
		tie: row.creation,
		key: `${prefix}:${row.id}`,
	});
	return (before: StreamPosition | null) =>
		readSourceBatch(
			rangesBefore(before, {
				all: () => indexDesc(rows, () => true),
				tied: (at, tie) => indexDesc(rows, (r) => r.at === at && r.creation <= tie),
				older: (at) => indexDesc(rows, (r) => r.at < at),
			}),
			{
				before,
				limit: opts.limit,
				budget: opts.budget,
				positionOf,
				toEntries: (row) => {
					if (row.isHidden) return [];
					const own = positionOf(row);
					const children = Array.from({ length: row.children ?? 0 }, (_, i) => ({
						...own,
						key: `${own.key}~reply:${i}`,
					}));
					return [own, ...children];
				},
			}
		);
}

/** Walk every page from the newest and return the stream oldest first. */
async function walk(sources: ReturnType<typeof source>[], limit: number) {
	const pages: StreamPosition[][] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 500; i++) {
		const before = decodeStreamCursor(cursor);
		const batches = await Promise.all(sources.map((read) => read(before)));
		const page = mergeStreamPage(batches, limit);
		pages.push(page.entries);
		if (page.isDone) return pages.reverse().flat();
		expect(page.cursor).not.toBeNull();
		cursor = page.cursor;
	}
	throw new Error('the walk did not end');
}

/** Rows whose ids run against their creation order, many sharing one timestamp. */
function tiedRows(count: number, at: number, start: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `z${String(count - i).padStart(3, '0')}`,
		at,
		creation: start + i,
	}));
}

describe('stream cursors', () => {
	it('round-trip a position whose key holds separators', () => {
		const position = { at: 1_700_000_000_000, tie: 1_700_000_000_000.5, key: 'note:abc|def' };
		expect(decodeStreamCursor(encodeStreamCursor(position))).toEqual(position);
	});

	it('read a foreign or empty cursor as the newest page', () => {
		expect(decodeStreamCursor(null)).toBeNull();
		expect(decodeStreamCursor('')).toBeNull();
		expect(decodeStreamCursor('not a cursor')).toBeNull();
		expect(decodeStreamCursor('1|NaN|key')).toBeNull();
		expect(decodeStreamCursor('1|2')).toBeNull();
	});
});

describe('mergeStreamPage', () => {
	it('orders by time, then creation, then key, oldest first', () => {
		const page = mergeStreamPage(
			[
				{ entries: [{ at: 5, tie: 9, key: 'a' }], floor: null },
				{
					entries: [
						{ at: 5, tie: 10, key: 'activity:0' },
						{ at: 1, tie: 1, key: 'note:z' },
					],
					floor: null,
				},
			],
			10
		);
		expect(page.entries.map((e) => e.key)).toEqual(['note:z', 'a', 'activity:0']);
		expect(page).toMatchObject({ cursor: null, isDone: true });
	});

	it('never shows an entry below a source that stopped early', () => {
		const page = mergeStreamPage(
			[
				{ entries: [{ at: 9, tie: 9, key: 'note:1' }], floor: { at: 8, tie: 8, key: 'note:2' } },
				{
					entries: [
						{ at: 10, tie: 10, key: 'email:1' },
						{ at: 3, tie: 3, key: 'email:2' },
					],
					floor: null,
				},
			],
			10
		);
		expect(page.entries.map((e) => e.key)).toEqual(['note:1', 'email:1']);
		expect(decodeStreamCursor(page.cursor)).toEqual({ at: 8, tie: 8, key: 'note:2' });
		expect(page.isDone).toBe(false);
	});
});

describe('paging across sources, in actual index order', () => {
	it('walks every entry exactly once through runs of equal timestamps', async () => {
		// Ids descend while creation ascends: key order disagrees with the index.
		const notes = [
			...tiedRows(9, 100, 1),
			...tiedRows(4, 50, 20),
			{ id: 'a', at: 10, creation: 30 },
		];
		const activity = [
			...tiedRows(7, 100, 2.5),
			{ id: 'h1', at: 100, creation: 40, isHidden: true },
			...tiedRows(3, 60, 41),
		];
		const emails: Row[] = [
			{ id: 'e2', at: 100, creation: 100, children: 2 },
			{ id: 'e1', at: 50, creation: 50, children: 1 },
			{ id: 'e0', at: 5, creation: 5 },
		];
		const expected = [
			...notes.map((r) => ({ at: r.at, tie: r.creation, key: `note:${r.id}` })),
			...activity
				.filter((r) => !r.isHidden)
				.map((r) => ({ at: r.at, tie: r.creation, key: `activity:${r.id}` })),
			...emails.flatMap((r) => [
				{ at: r.at, tie: r.creation, key: `email:${r.id}` },
				...Array.from({ length: r.children ?? 0 }, (_, i) => ({
					at: r.at,
					tie: r.creation,
					key: `email:${r.id}~reply:${i}`,
				})),
			]),
		]
			.sort(compareStreamPositions)
			.map((p) => p.key);
		for (const limit of [1, 2, 3, 5, 8, 50]) {
			for (const budget of [1, 2, 4, 100]) {
				const walked = await walk(
					[
						source('note', notes, { limit, budget }),
						source('activity', activity, { limit, budget }),
						source('email', emails, { limit, budget }),
					],
					limit
				);
				expect(walked.map((r) => r.key)).toEqual(expected);
			}
		}
	});

	it('ends at once on an empty thread', async () => {
		const page = mergeStreamPage([{ entries: [], floor: null }], 5);
		expect(page).toEqual({ entries: [], cursor: null, isDone: true });
	});
});

describe('what the stream shows', () => {
	it('keeps substance activity that no bubble shows', () => {
		expect(isStreamActivity({ type: 'item_closed', visibility: 'substance' })).toBe(true);
		expect(isStreamActivity({ type: 'send_held', visibility: 'substance' })).toBe(true);
		expect(isStreamActivity({ type: 'assigned', visibility: 'housekeeping' })).toBe(false);
		expect(isStreamActivity({ type: 'message_received', visibility: 'substance' })).toBe(false);
		expect(isStreamActivity({ type: 'reply_sent', visibility: 'substance' })).toBe(false);
	});

	it('keeps a reply queued or failed as it is', () => {
		expect(teamReplyStatusOf('queued')).toBe('queued');
		expect(teamReplyStatusOf('bounced')).toBe('failed');
		expect(teamReplyStatusOf('delivered')).toBe('sent');
		expect(outboundStatusOf([{ state: 'sent' }, { state: 'bounced' }])).toBe('failed');
		expect(outboundStatusOf([{ state: 'sent' }, { state: 'queued' }])).toBe('queued');
		expect(outboundStatusOf([{ state: 'sent' }])).toBe('sent');
	});

	it('previews raw text on one bounded line', () => {
		expect(streamPreview('Hi Ana,\n\n  thanks ')).toBe('Hi Ana, thanks');
		expect([...streamPreview('x'.repeat(400))].length).toBe(280);
	});
});
