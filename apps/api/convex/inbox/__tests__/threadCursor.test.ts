/**
 * The `listThreads` cursor carries the first page's `now` (see
 * `pinThreadCursor` in ../threadFilters). These cases pin the format both ways.
 */

import { describe, expect, it } from 'vitest';
import { openThreadCursor, pinThreadCursor } from '../threadFilters';

describe('listThreads cursor pinning', () => {
	it('round-trips the pinned now and the Convex cursor', () => {
		const cursor = pinThreadCursor(1_790_000_000_000, 'abc:def==');
		expect(openThreadCursor(cursor, 5)).toEqual({ now: 1_790_000_000_000, cursor: 'abc:def==' });
	});

	it('reads no cursor as a first page at the fallback now', () => {
		expect(openThreadCursor(undefined, 42)).toEqual({ now: 42, cursor: null });
		expect(openThreadCursor('', 42)).toEqual({ now: 42, cursor: null });
	});

	it('passes a cursor without a pin through unchanged', () => {
		expect(openThreadCursor('rawConvexCursor', 42)).toEqual({ now: 42, cursor: 'rawConvexCursor' });
	});
});
