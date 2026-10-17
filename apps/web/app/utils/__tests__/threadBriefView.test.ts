/**
 * The cite link of a brief line (SPEC §7, plan §4.2): `?cite=<ref>:<n>`.
 * The reader is one page now (read on arrival §3), so there is no view to
 * resolve; only the cite round-trip is left.
 */
import { describe, expect, it } from 'vitest';
import { formatCite, latestCiteRef, parseCite } from '../threadBriefView';

describe('cite params', () => {
	it('round-trips a cite, including a latest-update line', () => {
		expect(parseCite('item123:2')).toEqual({ ref: 'item123', quoteIndex: 2 });
		expect(parseCite(formatCite({ ref: latestCiteRef(1), quoteIndex: 0 }))).toEqual({
			ref: 'latest-1',
			quoteIndex: 0,
		});
	});

	it('rejects malformed cites', () => {
		for (const raw of ['', 'abc', ':1', 'abc:-1', 'abc:x', 3, undefined]) {
			expect(parseCite(raw)).toBeNull();
		}
	});
});
