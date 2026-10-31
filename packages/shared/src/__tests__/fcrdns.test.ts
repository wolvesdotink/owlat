import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	parseGenericPtrSuffixes,
	parseUnverifiedFcrdnsOverride,
	reverseDnsGuidance,
	verifyFcrdnsIdentity,
} from '../fcrdns';

/**
 * Whether a forward-confirmed PTR that matches EHLO is flagged as a provider's
 * generic hostname: the only place the generic-PTR heuristic surfaces.
 */
async function isGenericPtr(hostname: string, extraSuffixes: readonly string[] = []) {
	const result = await verifyFcrdnsIdentity(
		'198.51.100.7',
		hostname,
		{ reverse: vi.fn(async () => [hostname]), resolve4: vi.fn(async () => ['198.51.100.7']) },
		extraSuffixes
	);
	expect(result.checklist.ehloMatches).toBe(true);
	return result.genericPtr;
}

describe('generic PTR data and heuristic', () => {
	it('ships provider-default suffixes as built-in data', async () => {
		expect(await isGenericPtr('mail.your-server.de')).toBe(true);
		expect(await isGenericPtr('host.compute.amazonaws.com')).toBe(true);
	});

	it('matches suffixes and embedded dotted/dashed IPv4 without arbitrary regex input', async () => {
		expect(await isGenericPtr('static.203.0.113.10.clients.your-server.de')).toBe(true);
		expect(await isGenericPtr('ip-203-0-113-10.example.net')).toBe(true);
		expect(await isGenericPtr('mail.customer-vps.test', ['customer-vps.test'])).toBe(true);
		expect(await isGenericPtr('mail.example.com')).toBe(false);
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
	afterEach(() => vi.useRealTimers());

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

	it('bounds a reverse lookup that never settles', async () => {
		vi.useFakeTimers();
		const resultPromise = verifyFcrdnsIdentity(
			'203.0.113.10',
			'mail.example.com',
			{ reverse: vi.fn(() => new Promise<string[]>(() => {})), resolve4: vi.fn() },
			[],
			100
		);
		await vi.advanceTimersByTimeAsync(100);
		await expect(resultPromise).resolves.toMatchObject({
			verdict: 'error',
			reason: 'lookup-error',
		});
	});

	it('bounds the entire identity check when a forward lookup never settles', async () => {
		vi.useFakeTimers();
		const resultPromise = verifyFcrdnsIdentity(
			'203.0.113.10',
			'mail.example.com',
			{
				reverse: vi.fn(async () => ['mail.example.com']),
				resolve4: vi.fn(() => new Promise<string[]>(() => {})),
			},
			[],
			100
		);
		await vi.advanceTimersByTimeAsync(100);
		await expect(resultPromise).resolves.toMatchObject({
			verdict: 'error',
			reason: 'lookup-error',
		});
	});

	it('checks multiple identities in parallel within one timeout budget', async () => {
		vi.useFakeTimers();
		const deps = { reverse: vi.fn(() => new Promise<string[]>(() => {})), resolve4: vi.fn() };
		const checks = ['203.0.113.10', '203.0.113.11', '203.0.113.12'].map((ip) =>
			verifyFcrdnsIdentity(ip, 'mail.example.com', deps, [], 100)
		);
		await vi.advanceTimersByTimeAsync(100);
		const results = await Promise.all(checks);
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.reason === 'lookup-error')).toBe(true);
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
