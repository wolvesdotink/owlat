/**
 * The shape guards, and the one list this package duplicates.
 *
 * `parse.ts` holds its own copy of the five tier names because core does not
 * export `TIERS`. A copy that drifts fails *closed* — every snapshot and diff
 * entry carrying the new tier is rejected — which is the kind of break nobody
 * notices for a month, so the two lists are tied together here: anything core's
 * own answer parser accepts must be something this package's guards accept.
 */

import { formatDnsTierAnswer, parseDnsTierAnswer, type Tier } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { isSnapshotEntry, isSnapshotFile, isTier, parsePersistedSnapshot } from '../parse.js';
import { entry, HEAD, signedSnapshot } from './fixtures.js';

/**
 * Exhaustive by construction: adding a member to core's `Tier` union makes this
 * a type error, which is the compile-time half of the same guard.
 */
const EVERY_TIER: Readonly<Record<Tier, true>> = {
	unknown: true,
	establishing: true,
	trusted: true,
	warned: true,
	flagged: true,
};

describe('tier names do not drift from @owlat/ostr-core', () => {
	it.each(Object.keys(EVERY_TIER) as Tier[])(
		'accepts the %s tier in a snapshot entry, exactly as core parses it',
		(tier) => {
			const answer = parseDnsTierAnswer(
				formatDnsTierAnswer({ v: 1, tier, score: 50, policy: 'p', asof: '2026-08-20T06:00:00Z' })
			);
			expect(answer.ok).toBe(true);
			expect(isTier(tier)).toBe(true);
			expect(isSnapshotEntry(entry({ domain: 'a.example' }, tier, 50))).toBe(true);
		}
	);

	it.each(['', 'TRUSTED', 'banned', 'unknown ', 1, null, undefined])(
		'refuses %p as a tier',
		(value) => {
			expect(isTier(value)).toBe(false);
		}
	);

	it('does not accept an inherited property as a tier', () => {
		expect(isTier('toString')).toBe(false);
		expect(isTier('constructor')).toBe(false);
	});
});

describe('isSnapshotEntry', () => {
	it.each([
		['a non-integer score', { subject: { domain: 'a.example' }, tier: 'trusted', score: 1.5 }],
		['a score over 100', { subject: { domain: 'a.example' }, tier: 'trusted', score: 101 }],
		['a negative score', { subject: { domain: 'a.example' }, tier: 'trusted', score: -1 }],
		['no subject', { tier: 'trusted', score: 10 }],
		['an empty subject', { subject: {}, tier: 'trusted', score: 10 }],
		['a non-string domain', { subject: { domain: 7 }, tier: 'trusted', score: 10 }],
	])('rejects %s', (_label, value) => {
		expect(isSnapshotEntry(value)).toBe(false);
	});
});

describe('isSnapshotFile', () => {
	it('accepts the snapshot the fixtures sign', () => {
		expect(
			isSnapshotFile(signedSnapshot([entry({ domain: 'a.example' }, 'trusted', 90)]).snapshot)
		).toBe(true);
	});

	it('rejects a snapshot that claims no as-of head set at all', () => {
		// Spec 08 §8.3: a snapshot MUST carry the as-of head set. An empty one
		// states no coverage, and §8.1's `asof` rule has nothing to read.
		const { snapshot } = signedSnapshot([entry({ domain: 'a.example' }, 'trusted', 90)]);
		expect(isSnapshotFile({ ...snapshot, heads: [] })).toBe(false);
		expect(isSnapshotFile({ ...snapshot, heads: ['not-a-head'] })).toBe(false);
		expect(isSnapshotFile({ ...snapshot, heads: [HEAD] })).toBe(true);
	});

	it.each([
		['a missing policy', { policy: '' }],
		['a missing asOf', { asOf: '' }],
		['a missing signature', { sig: '' }],
		['an unsupported version', { v: 2 }],
	])('rejects a snapshot with %s', (_label, patch) => {
		const { snapshot } = signedSnapshot([entry({ domain: 'a.example' }, 'trusted', 90)]);
		expect(isSnapshotFile({ ...snapshot, ...patch })).toBe(false);
	});
});

describe('parsePersistedSnapshot', () => {
	it('round-trips what the store writes', () => {
		const { snapshot } = signedSnapshot([entry({ domain: 'a.example' }, 'trusted', 90)]);
		const text = JSON.stringify({ v: 1, snapshot, diffs: [] });
		expect(parsePersistedSnapshot(text)).toEqual({ v: 1, snapshot, diffs: [] });
	});

	it.each(['', 'null', '[]', '{"v":1,"snapshot":null,"diffs":[]}'])(
		'refuses the payload %p',
		(text) => {
			expect(parsePersistedSnapshot(text)).toBeNull();
		}
	);

	it('refuses a document whose diffs are not diff entries', () => {
		const { snapshot } = signedSnapshot([entry({ domain: 'a.example' }, 'trusted', 90)]);
		const text = JSON.stringify({ v: 1, snapshot, diffs: [{ seq: 1 }] });
		expect(parsePersistedSnapshot(text)).toBeNull();
	});
});
