import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_GENERIC_PTR_SUFFIXES,
	isGenericPtrHostname,
	parseGenericPtrSuffixes,
	parseUnverifiedFcrdnsOverride,
	reverseDnsGuidance,
	verifyFcrdnsIdentity,
} from '../fcrdns';

describe('generic PTR data and heuristic', () => {
	it('ships provider-default suffixes as inspectable data', () => {
		expect(DEFAULT_GENERIC_PTR_SUFFIXES).toContain('your-server.de');
		expect(DEFAULT_GENERIC_PTR_SUFFIXES).toContain('compute.amazonaws.com');
	});

	it('matches suffixes and embedded dotted/dashed IPv4 without arbitrary regex input', () => {
		expect(isGenericPtrHostname('static.203.0.113.10.clients.your-server.de')).toBe(true);
		expect(isGenericPtrHostname('ip-203-0-113-10.example.net')).toBe(true);
		expect(isGenericPtrHostname('mail.customer-vps.test', ['customer-vps.test'])).toBe(true);
		expect(isGenericPtrHostname('mail.example.com')).toBe(false);
	});

	it('strictly parses shared readiness options for setup and runtime', () => {
		expect(parseGenericPtrSuffixes(' Provider.Example.,provider.example ')).toEqual([
			'provider.example',
		]);
		expect(() => parseGenericPtrSuffixes('not a suffix')).toThrow('invalid DNS suffix');
		expect(parseUnverifiedFcrdnsOverride(undefined)).toBe(false);
		expect(parseUnverifiedFcrdnsOverride('true')).toBe(true);
		expect(() => parseUnverifiedFcrdnsOverride('yes')).toThrow('must be true or false');
	});
});

describe('verifyFcrdnsIdentity', () => {
	it('requires the same forward-confirmed PTR to match EHLO', async () => {
		const result = await verifyFcrdnsIdentity('203.0.113.10', 'mail.example.com', {
			reverse: vi.fn(async () => ['other.example.com', 'mail.example.com']),
			resolve4: vi.fn(async (name: string) =>
				name === 'other.example.com' ? ['203.0.113.10'] : ['203.0.113.11']
			),
		});
		expect(result).toMatchObject({ verdict: 'fail', reason: 'ehlo-mismatch' });
	});

	it('returns the complete checklist for a ready identity', async () => {
		const result = await verifyFcrdnsIdentity('203.0.113.10', 'Mail.Example.com.', {
			reverse: vi.fn(async () => ['mail.example.com.']),
			resolve4: vi.fn(async () => ['203.0.113.10']),
		});
		expect(result).toMatchObject({
			verdict: 'pass',
			checklist: {
				ptrExists: true,
				ptrIsFqdn: true,
				forwardConfirmed: true,
				ehloMatches: true,
			},
		});
	});
});

describe('reverseDnsGuidance', () => {
	it.each([
		['static.clients.your-server.de', 'Hetzner Console'],
		['host.digitalocean.com', 'DigitalOcean control panel'],
		['host.rev.poneytelecom.eu', 'OVHcloud Manager'],
	])('provides an actionable provider path for %s', (ptr, copy) => {
		expect(reverseDnsGuidance([ptr]).instruction).toContain(copy);
	});
});
