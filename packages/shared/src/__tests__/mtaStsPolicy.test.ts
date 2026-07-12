/**
 * Unit tests for the shared MTA-STS policy serializer in `../mtaStsPolicy.ts`.
 * These back the Convex policy query, the Nuxt `/.well-known/mta-sts.txt` route
 * and the DNS-guidance UI, so the exact RFC 8461 body per mode and the "id
 * changes iff mode/MX change" contract are asserted here.
 */

import { describe, it, expect } from 'vitest';
import {
	MTA_STS_MODES,
	MTA_STS_MAX_AGE_SECONDS,
	isMtaStsMode,
	mtaStsPolicyId,
	buildMtaStsTxtValue,
	buildMtaStsPolicy,
} from '../mtaStsPolicy';

describe('MtaStsMode', () => {
	it('lists the three modes in strictness order', () => {
		expect(MTA_STS_MODES).toEqual(['none', 'testing', 'enforce']);
	});

	it('narrows valid mode strings and rejects others', () => {
		expect(isMtaStsMode('none')).toBe(true);
		expect(isMtaStsMode('testing')).toBe(true);
		expect(isMtaStsMode('enforce')).toBe(true);
		expect(isMtaStsMode('require')).toBe(false);
		expect(isMtaStsMode('')).toBe(false);
	});
});

describe('buildMtaStsPolicy', () => {
	it('produces the exact RFC 8461 body for enforce with one MX', () => {
		expect(buildMtaStsPolicy('enforce', ['mail.example.com'])).toBe(
			'version: STSv1\r\n' +
				'mode: enforce\r\n' +
				'mx: mail.example.com\r\n' +
				`max_age: ${MTA_STS_MAX_AGE_SECONDS}\r\n`
		);
	});

	it('produces the exact RFC 8461 body for testing mode', () => {
		expect(buildMtaStsPolicy('testing', ['mail.example.com'])).toBe(
			'version: STSv1\r\n' +
				'mode: testing\r\n' +
				'mx: mail.example.com\r\n' +
				`max_age: ${MTA_STS_MAX_AGE_SECONDS}\r\n`
		);
	});

	it('lowercases, de-duplicates and sorts MX hosts into one mx line each', () => {
		expect(
			buildMtaStsPolicy('enforce', ['MX2.example.com', 'mx1.example.com', 'mx2.example.com'])
		).toBe(
			'version: STSv1\r\n' +
				'mode: enforce\r\n' +
				'mx: mx1.example.com\r\n' +
				'mx: mx2.example.com\r\n' +
				`max_age: ${MTA_STS_MAX_AGE_SECONDS}\r\n`
		);
	});

	it('ends every line with CRLF per the RFC ABNF', () => {
		const body = buildMtaStsPolicy('enforce', ['mail.example.com']);
		for (const line of body.split('\r\n').filter(Boolean)) {
			expect(body).toContain(`${line}\r\n`);
		}
		expect(body.endsWith('\r\n')).toBe(true);
	});
});

describe('mtaStsPolicyId', () => {
	it('is deterministic and independent of MX order and case', () => {
		const a = mtaStsPolicyId('enforce', ['mx1.example.com', 'mx2.example.com']);
		const b = mtaStsPolicyId('enforce', ['MX2.example.com', 'mx1.example.com']);
		expect(a).toBe(b);
	});

	it('changes when the mode changes (same MX set)', () => {
		const testing = mtaStsPolicyId('testing', ['mail.example.com']);
		const enforce = mtaStsPolicyId('enforce', ['mail.example.com']);
		expect(testing).not.toBe(enforce);
	});

	it('changes when the MX set changes (same mode)', () => {
		const one = mtaStsPolicyId('enforce', ['mail.example.com']);
		const two = mtaStsPolicyId('enforce', ['mail.example.com', 'mx2.example.com']);
		expect(one).not.toBe(two);
	});

	it('does NOT change when only irrelevant formatting differs', () => {
		const canonical = mtaStsPolicyId('enforce', ['mail.example.com']);
		const padded = mtaStsPolicyId('enforce', ['  MAIL.example.com  ', 'mail.example.com']);
		expect(padded).toBe(canonical);
	});

	it('is a 16-char lowercase hex token (within the RFC id length limit)', () => {
		expect(mtaStsPolicyId('enforce', ['mail.example.com'])).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('buildMtaStsTxtValue', () => {
	it('wraps the policy id in the RFC 8461 TXT record shape', () => {
		expect(buildMtaStsTxtValue('abc123')).toBe('v=STSv1; id=abc123');
	});
});
