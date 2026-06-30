/**
 * Unit tests for the pure DMARC record builder in `domains/dmarc.ts`.
 * No Convex setup; `buildDmarcRecordValue` is a pure function.
 *
 * Covers the RFC 7489 §6.3 enforcement tags the builder emits — `p=`, `sp=`
 * (subdomain policy), `pct=` (staged rollout), `adkim=`/`aspf=` (alignment
 * strictness), and `rua=` (aggregate reporting). The `rua=` tag is only
 * emitted when the operator opts in (Owlat does not provision a
 * `dmarc@<customer-domain>` mailbox).
 */

import { describe, it, expect } from 'vitest';
import {
	buildDmarcRecordValue,
	isDmarcAlignment,
	isDmarcPolicy,
} from '../domains/dmarc';

describe('buildDmarcRecordValue', () => {
	it('emits the minimal v=DMARC1; p=<policy> with no optional tags', () => {
		expect(buildDmarcRecordValue('example.com', { policy: 'none' })).toBe(
			'v=DMARC1; p=none',
		);
		expect(buildDmarcRecordValue('example.com', { policy: 'reject' })).toBe(
			'v=DMARC1; p=reject',
		);
	});

	it('reflects the requested policy in the p= tag', () => {
		expect(buildDmarcRecordValue('example.com', { policy: 'quarantine' })).toContain(
			'p=quarantine',
		);
	});

	it('emits the subdomain policy as sp= (RFC 7489 §6.3)', () => {
		expect(
			buildDmarcRecordValue('d', { policy: 'reject', subdomainPolicy: 'none' }),
		).toBe('v=DMARC1; p=reject; sp=none');
		expect(
			buildDmarcRecordValue('d', {
				policy: 'reject',
				subdomainPolicy: 'quarantine',
			}),
		).toBe('v=DMARC1; p=reject; sp=quarantine');
	});

	it('emits the staged-rollout percentage as pct=', () => {
		expect(buildDmarcRecordValue('d', { policy: 'quarantine', pct: 10 })).toBe(
			'v=DMARC1; p=quarantine; pct=10',
		);
		// Boundary values are valid.
		expect(buildDmarcRecordValue('d', { policy: 'reject', pct: 0 })).toBe(
			'v=DMARC1; p=reject; pct=0',
		);
		expect(buildDmarcRecordValue('d', { policy: 'reject', pct: 100 })).toBe(
			'v=DMARC1; p=reject; pct=100',
		);
	});

	it('throws when pct is outside the 0–100 range', () => {
		expect(() =>
			buildDmarcRecordValue('d', { policy: 'reject', pct: 101 }),
		).toThrow();
		expect(() =>
			buildDmarcRecordValue('d', { policy: 'reject', pct: -1 }),
		).toThrow();
		expect(() =>
			buildDmarcRecordValue('d', { policy: 'reject', pct: 10.5 }),
		).toThrow();
	});

	it('emits the DKIM alignment strictness as adkim=', () => {
		expect(buildDmarcRecordValue('d', { policy: 'reject', adkim: 's' })).toContain(
			'adkim=s',
		);
		expect(buildDmarcRecordValue('d', { policy: 'reject', adkim: 'r' })).toBe(
			'v=DMARC1; p=reject; adkim=r',
		);
	});

	it('emits the SPF alignment strictness as aspf=', () => {
		expect(buildDmarcRecordValue('d', { policy: 'reject', aspf: 's' })).toBe(
			'v=DMARC1; p=reject; aspf=s',
		);
	});

	it('omits rua= when no reporting address is configured', () => {
		expect(buildDmarcRecordValue('example.com', { policy: 'none' })).not.toContain(
			'rua=',
		);
	});

	it('omits rua= for an empty or whitespace-only address', () => {
		expect(
			buildDmarcRecordValue('example.com', { policy: 'quarantine', rua: '' }),
		).toBe('v=DMARC1; p=quarantine');
		expect(
			buildDmarcRecordValue('example.com', { policy: 'quarantine', rua: '   ' }),
		).toBe('v=DMARC1; p=quarantine');
	});

	it('appends the operator-configured rua= reporting URI verbatim', () => {
		expect(
			buildDmarcRecordValue('example.com', {
				policy: 'none',
				rua: 'mailto:dmarc-reports@owlat.example',
			}),
		).toBe('v=DMARC1; p=none; rua=mailto:dmarc-reports@owlat.example');
	});

	it('trims surrounding whitespace from the rua address', () => {
		expect(
			buildDmarcRecordValue('example.com', {
				policy: 'reject',
				rua: '  mailto:reports@owlat.example  ',
			}),
		).toBe('v=DMARC1; p=reject; rua=mailto:reports@owlat.example');
	});

	it('emits all tags together in RFC 7489 canonical order (v; p; sp; pct; adkim; aspf; rua)', () => {
		expect(
			buildDmarcRecordValue('example.com', {
				policy: 'reject',
				subdomainPolicy: 'quarantine',
				pct: 50,
				adkim: 's',
				aspf: 'r',
				rua: 'mailto:reports@owlat.example',
			}),
		).toBe(
			'v=DMARC1; p=reject; sp=quarantine; pct=50; adkim=s; aspf=r; rua=mailto:reports@owlat.example',
		);
	});
});

describe('isDmarcPolicy', () => {
	it('accepts the three valid policies', () => {
		expect(isDmarcPolicy('none')).toBe(true);
		expect(isDmarcPolicy('quarantine')).toBe(true);
		expect(isDmarcPolicy('reject')).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isDmarcPolicy('relaxed')).toBe(false);
		expect(isDmarcPolicy(undefined)).toBe(false);
		expect(isDmarcPolicy(null)).toBe(false);
	});
});

describe('isDmarcAlignment', () => {
	it('accepts the two alignment modes', () => {
		expect(isDmarcAlignment('r')).toBe(true);
		expect(isDmarcAlignment('s')).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isDmarcAlignment('strict')).toBe(false);
		expect(isDmarcAlignment('')).toBe(false);
		expect(isDmarcAlignment(undefined)).toBe(false);
		expect(isDmarcAlignment(null)).toBe(false);
	});
});
