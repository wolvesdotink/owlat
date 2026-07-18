/**
 * Shared return-path-host validator contract (F2 finding 3).
 *
 * This is the SINGLE validator both the MTA (`apps/mta` register-endpoint gate)
 * and the Convex backend (`setReturnPathHost` + the atomic add-domain path)
 * import, so their acceptance sets are identical by construction. The two cases
 * the review flagged — where the laxer `asDnsName` accepted a value the MTA then
 * rejected forever — are locked here as rejections.
 */

import { describe, it, expect } from 'vitest';
import { normalizeReturnPathHost, isValidReturnPathHost } from '../returnPathHost';

describe('normalizeReturnPathHost', () => {
	it('accepts a normal dotted FQDN and lower-cases it', () => {
		expect(normalizeReturnPathHost('bounce.example.com')).toBe('bounce.example.com');
		expect(normalizeReturnPathHost('Bounce.Example.COM')).toBe('bounce.example.com');
		expect(normalizeReturnPathHost('bounce.example.com.')).toBe('bounce.example.com');
	});

	// The two regressions the review flagged: asDnsName accepted these, the MTA
	// rejected them — Convex would commit + then 400 forever. Now both reject.
	it('rejects a single-label host (asDnsName accepted "localhost")', () => {
		expect(normalizeReturnPathHost('localhost')).toBeNull();
	});

	it('rejects an underscore service label (asDnsName accepted "_bounce.example.com")', () => {
		expect(normalizeReturnPathHost('_bounce.example.com')).toBeNull();
	});

	it('accepts punycode / IDN labels and TLDs', () => {
		expect(normalizeReturnPathHost('bounce.xn--80akhbyknj4f')).toBe('bounce.xn--80akhbyknj4f');
	});

	it.each([
		['empty', ''],
		['whitespace only', '   '],
		['interior whitespace', 'bounce example.com'],
		['contains @', 'bounce@example.com'],
		['contains a path', 'bounce.example.com/x'],
		['contains a port', 'bounce.example.com:25'],
		['scheme', 'http://bounce.example.com'],
		['leading hyphen label', '-bounce.example.com'],
		['trailing hyphen label', 'bounce-.example.com'],
		['double dot', 'bounce..example.com'],
		['leading dot', '.bounce.example.com'],
		['all-numeric TLD', 'bounce.example.123'],
		['bare IPv4', '10.0.0.5'],
		['label over 63 chars', `${'a'.repeat(64)}.com`],
		['non-string', 42],
		['null', null],
	])('rejects %s', (_label, value) => {
		expect(normalizeReturnPathHost(value)).toBeNull();
	});
});

describe('isValidReturnPathHost', () => {
	it('mirrors normalizeReturnPathHost', () => {
		expect(isValidReturnPathHost('bounce.example.com')).toBe(true);
		expect(isValidReturnPathHost('localhost')).toBe(false);
		expect(isValidReturnPathHost('_bounce.example.com')).toBe(false);
	});
});
