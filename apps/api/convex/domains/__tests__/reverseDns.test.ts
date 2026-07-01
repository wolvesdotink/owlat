/**
 * Unit tests for the reverse-DNS (PTR / FCrDNS) preflight helper backing the
 * Settings → Domains "Receiving" panel (`domains/reverseDns.ts`).
 *
 * The live `node:dns` calls are injected via `ReverseDnsDeps`, so these tests
 * exercise the classification + host-match logic without touching real DNS and
 * assert the helper is fail-soft (never throws) on every lookup error.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkReverseDns, normalizeHost, type ReverseDnsDeps } from '../reverseDns';

/**
 * Build DNS deps from simple maps:
 *  - fwd: hostname → A records
 *  - ptr: ip       → PTR names
 * A missing key throws ENOTFOUND, matching Node's `dns/promises` behaviour.
 */
function makeDeps(fwd: Record<string, string[]>, ptr: Record<string, string[]>): ReverseDnsDeps {
	const notFound = (target: string) =>
		Object.assign(new Error(`ENOTFOUND ${target}`), { code: 'ENOTFOUND' });
	return {
		resolve4: vi.fn(async (hostname: string) => {
			if (!(hostname in fwd)) throw notFound(hostname);
			return fwd[hostname]!;
		}),
		reverse: vi.fn(async (ip: string) => {
			if (!(ip in ptr)) throw notFound(ip);
			return ptr[ip]!;
		}),
	};
}

describe('checkReverseDns', () => {
	it('matchesHost when the PTR equals the mail host (forward-confirmed reverse DNS)', async () => {
		const deps = makeDeps({ 'mail.example.com': ['1.2.3.4'] }, { '1.2.3.4': ['mail.example.com'] });
		const result = await checkReverseDns('mail.example.com', deps);
		expect(result).toEqual({
			hasPtr: true,
			ptrValue: 'mail.example.com',
			matchesHost: true,
			checkedHost: 'mail.example.com',
		});
	});

	it('hasPtr false when the IP has no PTR record', async () => {
		// Host resolves, but the IP has no PTR (reverse throws ENOTFOUND).
		const deps = makeDeps({ 'mail.example.com': ['1.2.3.4'] }, {});
		const result = await checkReverseDns('mail.example.com', deps);
		expect(result.hasPtr).toBe(false);
		expect(result.matchesHost).toBe(false);
		expect(result.ptrValue).toBeUndefined();
		expect(result.checkedHost).toBe('mail.example.com');
	});

	it('hasPtr true but matchesHost false when the PTR points elsewhere', async () => {
		const deps = makeDeps(
			{ 'mail.example.com': ['1.2.3.4'] },
			{ '1.2.3.4': ['other-host.provider.net'] },
		);
		const result = await checkReverseDns('mail.example.com', deps);
		expect(result.hasPtr).toBe(true);
		expect(result.ptrValue).toBe('other-host.provider.net');
		expect(result.matchesHost).toBe(false);
	});

	it('normalizes a trailing dot and case on both host and PTR before comparing', async () => {
		const deps = makeDeps({ 'mail.example.com': ['1.2.3.4'] }, { '1.2.3.4': ['Mail.Example.COM.'] });
		const result = await checkReverseDns('Mail.Example.com.', deps);
		expect(result.checkedHost).toBe('mail.example.com');
		expect(result.ptrValue).toBe('mail.example.com');
		expect(result.matchesHost).toBe(true);
	});

	it('fails soft (hasPtr false) when the host has no A record', async () => {
		const deps = makeDeps({}, {});
		const result = await checkReverseDns('mail.example.com', deps);
		expect(result).toEqual({ hasPtr: false, matchesHost: false, checkedHost: 'mail.example.com' });
		// The reverse lookup is never attempted when forward resolution fails.
		expect(deps.reverse).not.toHaveBeenCalled();
	});

	it('returns the base result for an empty host without any lookup', async () => {
		const deps = makeDeps({}, {});
		const result = await checkReverseDns('   ', deps);
		expect(result).toEqual({ hasPtr: false, matchesHost: false, checkedHost: '' });
		expect(deps.resolve4).not.toHaveBeenCalled();
	});

	it('never throws when both lookups reject with unexpected errors', async () => {
		const deps: ReverseDnsDeps = {
			resolve4: vi.fn(async () => ['1.2.3.4']),
			reverse: vi.fn(async () => {
				throw new Error('SERVFAIL');
			}),
		};
		await expect(checkReverseDns('mail.example.com', deps)).resolves.toEqual({
			hasPtr: false,
			matchesHost: false,
			checkedHost: 'mail.example.com',
		});
	});
});

describe('normalizeHost', () => {
	it('lowercases, trims, and strips a single trailing dot', () => {
		expect(normalizeHost('Mail.Example.COM.')).toBe('mail.example.com');
		expect(normalizeHost('  Host.Example  ')).toBe('host.example');
	});
});
