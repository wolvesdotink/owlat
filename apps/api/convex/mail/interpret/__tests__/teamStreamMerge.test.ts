/**
 * The team stream's paging rules (teamStreamMerge.ts): one order across
 * sources, stable cursors, and pages that never skip or repeat an entry, also
 * when a source stops early on its scan budget.
 */

import { describe, expect, it } from 'vitest';
import {
	compareStreamPositions,
	decodeStreamCursor,
	encodeStreamCursor,
	isStreamActivity,
	mergeStreamPage,
	outboundStatusOf,
	readSourceBatch,
	streamPreview,
	teamReplyStatusOf,
	type StreamPosition,
} from '../teamStreamMerge';

type Row = StreamPosition & { isHidden?: boolean };

async function* iterate<T>(rows: readonly T[]): AsyncIterable<T> {
	for (const row of rows) yield row;
}

/** A source as an index would serve it: newest first, from `before` down. */
function source(rows: readonly Row[], opts: { limit: number; budget: number }) {
	const newestFirst = [...rows].sort((a, b) => compareStreamPositions(b, a));
	return (before: StreamPosition | null) =>
		readSourceBatch(iterate(newestFirst), {
			before,
			limit: opts.limit,
			budget: opts.budget,
			positionOf: (row) => row,
			toEntry: (row) => (row.isHidden ? null : row),
		});
}

/** Walk every page from the newest and return the stream oldest first. */
async function walk(
	sources: ((before: StreamPosition | null) => ReturnType<ReturnType<typeof source>>)[],
	limit: number
) {
	const pages: Row[][] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 100; i++) {
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

function rows(prefix: string, ats: number[], hidden: number[] = []): Row[] {
	return ats.map((at, i) => ({ at, key: `${prefix}:${i}`, isHidden: hidden.includes(i) }));
}

describe('stream cursors', () => {
	it('round-trip a position whose key holds separators', () => {
		const position = { at: 1_700_000_000_000, key: 'note:abc|def' };
		expect(decodeStreamCursor(encodeStreamCursor(position))).toEqual(position);
	});

	it('read a foreign or empty cursor as the newest page', () => {
		expect(decodeStreamCursor(null)).toBeNull();
		expect(decodeStreamCursor('')).toBeNull();
		expect(decodeStreamCursor('not a cursor')).toBeNull();
		expect(decodeStreamCursor('NaN|key')).toBeNull();
	});
});

describe('mergeStreamPage', () => {
	it('orders by time, then by key, oldest first', () => {
		const page = mergeStreamPage(
			[
				{ entries: [{ at: 5, key: 'email:b' }], floor: null },
				{
					entries: [
						{ at: 5, key: 'activity:a' },
						{ at: 1, key: 'note:z' },
					],
					floor: null,
				},
			],
			10
		);
		expect(page.entries.map((e) => e.key)).toEqual(['note:z', 'activity:a', 'email:b']);
		expect(page).toMatchObject({ cursor: null, isDone: true });
	});

	it('never shows an entry below a source that stopped early', () => {
		const page = mergeStreamPage(
			[
				{ entries: [{ at: 9, key: 'note:1' }], floor: { at: 8, key: 'note:2' } },
				{
					entries: [
						{ at: 10, key: 'email:1' },
						{ at: 3, key: 'email:2' },
					],
					floor: null,
				},
			],
			10
		);
		expect(page.entries.map((e) => e.key)).toEqual(['note:1', 'email:1']);
		expect(decodeStreamCursor(page.cursor)).toEqual({ at: 8, key: 'note:2' });
		expect(page.isDone).toBe(false);
	});
});

describe('paging across sources', () => {
	it('walks every entry exactly once, in order, whatever the page size', async () => {
		const emails = rows('email', [1, 4, 4, 9, 20, 21, 33]);
		const notes = rows('note', [2, 3, 4, 10, 11, 12, 13, 14, 30]);
		const activity = rows('activity', [4, 5, 6, 7, 8, 22, 23, 31, 32, 40], [1, 3, 6]);
		const expected = [...emails, ...notes, ...activity]
			.filter((r) => !r.isHidden)
			.sort(compareStreamPositions)
			.map((r) => r.key);
		for (const limit of [1, 2, 3, 5, 8, 50]) {
			for (const budget of [1, 2, 4, 100]) {
				const walked = await walk(
					[
						source(emails, { limit, budget }),
						source(notes, { limit, budget }),
						source(activity, { limit, budget }),
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
