import { describe, expect, it } from 'vitest';
import {
	deriveContactVerificationBadge,
	readAloudFingerprint,
	readAloudLines,
	resolveContactVerification,
} from '../postboxKeyVerification';

const PIN = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const OTHER = 'FFFF9999EEEE8888DDDD7777CCCC6666BBBB5555';

describe('resolveContactVerification', () => {
	it('is unverified until somebody checks', () => {
		expect(resolveContactVerification({ pinnedFingerprint: PIN })).toBe('unverified');
		expect(resolveContactVerification({ pinnedFingerprint: PIN, verifiedFingerprint: null })).toBe(
			'unverified'
		);
	});

	it('is verified while the checked key is still the pinned one', () => {
		expect(resolveContactVerification({ pinnedFingerprint: PIN, verifiedFingerprint: PIN })).toBe(
			'verified'
		);
	});

	it('ignores spacing and case, so a pasted grouped fingerprint still matches', () => {
		expect(
			resolveContactVerification({
				pinnedFingerprint: PIN,
				verifiedFingerprint: 'aaaa 1111 bbbb 2222 cccc 3333 dddd 4444 eeee 5555',
			})
		).toBe('verified');
	});

	it('goes stale the moment the pin moves — never silently verified', () => {
		expect(resolveContactVerification({ pinnedFingerprint: OTHER, verifiedFingerprint: PIN })).toBe(
			'stale'
		);
		expect(resolveContactVerification({ verifiedFingerprint: PIN })).toBe('stale');
	});

	it('agrees with the backend derivation on every combination', () => {
		// Mirrors convex/e2ee/pinning.ts:resolveVerificationState. The two run on
		// different machines from the same row, so they must not drift.
		const cases: [string | null, string | null, string][] = [
			[null, null, 'unverified'],
			[PIN, null, 'unverified'],
			[PIN, PIN, 'verified'],
			[PIN, OTHER, 'stale'],
			[null, PIN, 'stale'],
		];
		for (const [pinnedFingerprint, verifiedFingerprint, expected] of cases) {
			expect(resolveContactVerification({ pinnedFingerprint, verifiedFingerprint })).toBe(expected);
		}
	});
});

describe('deriveContactVerificationBadge', () => {
	it('says who did the checking', () => {
		const mine = deriveContactVerificationBadge(
			{ pinnedFingerprint: PIN, verifiedFingerprint: PIN },
			true
		);
		expect(mine.summary).toBe('shared.postboxKeyVerification.verifiedByYou');
		expect(mine.tone).toBe('ok');

		const theirs = deriveContactVerificationBadge(
			{ pinnedFingerprint: PIN, verifiedFingerprint: PIN },
			false
		);
		expect(theirs.summary).toBe('shared.postboxKeyVerification.verifiedByTeammate');
	});

	it('warns rather than quietly resetting when the checked key is gone', () => {
		const badge = deriveContactVerificationBadge({
			pinnedFingerprint: OTHER,
			verifiedFingerprint: PIN,
		});
		expect(badge.state).toBe('stale');
		expect(badge.tone).toBe('warn');
		expect(badge.summary).toBe('shared.postboxKeyVerification.stale');
	});

	it('stays muted, not alarming, for a key nobody has checked yet', () => {
		const badge = deriveContactVerificationBadge({ pinnedFingerprint: PIN });
		expect(badge.state).toBe('unverified');
		expect(badge.tone).toBe('muted');
	});

	it('only ever hands back catalog keys, never resolved copy', () => {
		for (const status of [
			{ pinnedFingerprint: PIN, verifiedFingerprint: PIN },
			{ pinnedFingerprint: OTHER, verifiedFingerprint: PIN },
			{ pinnedFingerprint: PIN },
		]) {
			expect(deriveContactVerificationBadge(status).summary).toMatch(
				/^shared\.postboxKeyVerification\./
			);
		}
	});
});

describe('readAloudFingerprint', () => {
	it('re-encodes each byte as a three-digit decimal number', () => {
		expect(readAloudFingerprint('A1B2')).toEqual(['161', '178']);
		// Low bytes keep their width so every group is read at the same length.
		expect(readAloudFingerprint('0001FF')).toEqual(['000', '001', '255']);
	});

	it('produces one number per byte of a real fingerprint', () => {
		expect(readAloudFingerprint(PIN)).toHaveLength(20);
	});

	it('is a re-encoding, not a hash — the bytes come back out', () => {
		const hex = readAloudFingerprint(PIN)
			.map((n) => Number(n).toString(16).toUpperCase().padStart(2, '0'))
			.join('');
		expect(hex).toBe(PIN);
	});

	it('tolerates the spacing and case the panel renders', () => {
		expect(readAloudFingerprint('a1b2')).toEqual(readAloudFingerprint('A1 B2'));
	});

	it('says nothing at all rather than half a number', () => {
		expect(readAloudFingerprint(null)).toEqual([]);
		expect(readAloudFingerprint('')).toEqual([]);
		expect(readAloudFingerprint('A1B')).toEqual([]); // odd length
		expect(readAloudFingerprint('ZZZZ')).toEqual([]); // not hex
	});
});

describe('readAloudLines', () => {
	it('chunks the numbers so a pair reading them can keep their place', () => {
		// AA AA 11 11 BB | BB 22 22 CC CC | 33 33 DD DD 44 | 44 EE EE 55 55
		expect(readAloudLines(PIN)).toEqual([
			'170 170 017 017 187',
			'187 034 034 204 204',
			'051 051 221 221 068',
			'068 238 238 085 085',
		]);
	});

	it('honours a custom line length and leaves no empty trailing line', () => {
		expect(readAloudLines('A1B2C3', 2)).toEqual(['161 178', '195']);
		expect(readAloudLines('A1B2', 2)).toEqual(['161 178']);
	});

	it('has nothing to say about an absent fingerprint', () => {
		expect(readAloudLines(null)).toEqual([]);
	});
});
