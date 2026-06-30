/**
 * Unit tests for the seq↔UID resolver (helpers/seqMap.ts).
 *
 * Fixture mailbox: three messages with UIDs 5, 9, 14 — sequence numbers
 * 1, 2, 3 (1-based position by UID ascending, RFC 3501 §2.3.1).
 */

import { describe, expect, it } from 'vitest';
import { buildSeqMap, resolveSet } from '../seqMap.js';

const map = buildSeqMap([14, 5, 9]); // unsorted input → sorted to 5,9,14

describe('resolveSet (non-UID, sequence numbers)', () => {
	it('maps positions to their UIDs', () => {
		expect(resolveSet(map, '2', false)).toEqual([{ uid: 9, seq: 2 }]);
		expect(resolveSet(map, '1:3', false)).toEqual([
			{ uid: 5, seq: 1 },
			{ uid: 9, seq: 2 },
			{ uid: 14, seq: 3 },
		]);
	});

	it('resolves * to the highest sequence number', () => {
		expect(resolveSet(map, '*', false)).toEqual([{ uid: 14, seq: 3 }]);
	});

	it('clamps an out-of-range upper bound to the mailbox size (CPU-DoS guard)', () => {
		// `FETCH 1:2000000000` must not spin a ~2-billion-iteration loop; the
		// clamp bounds it to map.uids.length, and the result is unchanged —
		// positions above the message count never resolve.
		const start = performance.now();
		const out = resolveSet(map, '1:2000000000', false);
		const elapsedMs = performance.now() - start;
		expect(out).toEqual([
			{ uid: 5, seq: 1 },
			{ uid: 9, seq: 2 },
			{ uid: 14, seq: 3 },
		]);
		// A clamped loop is 3 iterations; an unclamped one is ~2e9 (~30s).
		expect(elapsedMs).toBeLessThan(1000);
	});

	it('drops a range entirely above the message count', () => {
		expect(resolveSet(map, '5000:9000', false)).toEqual([]);
	});
});

describe('resolveSet (UID)', () => {
	it('maps UIDs to their true sequence numbers', () => {
		expect(resolveSet(map, '9', true)).toEqual([{ uid: 9, seq: 2 }]);
		expect(resolveSet(map, '5:14', true)).toEqual([
			{ uid: 5, seq: 1 },
			{ uid: 9, seq: 2 },
			{ uid: 14, seq: 3 },
		]);
	});

	it('resolves * to the highest UID', () => {
		expect(resolveSet(map, '*', true)).toEqual([{ uid: 14, seq: 3 }]);
	});
});
