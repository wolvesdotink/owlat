import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFreemailDomain, resolveNs } from '../domainPrecheck';

/** Build a `fetch` stub resolving to a Cloudflare DoH JSON response. */
function mockDoh(body: unknown, ok = true): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok,
			json: async () => body,
		})),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('isFreemailDomain', () => {
	it('flags well-known freemail / public-mailbox domains', () => {
		for (const domain of [
			'gmail.com',
			'googlemail.com',
			'outlook.com',
			'hotmail.com',
			'yahoo.com',
			'icloud.com',
			'proton.me',
			'web.de',
			'aol.com',
		]) {
			expect(isFreemailDomain(domain)).toBe(true);
		}
	});

	it('matches gmx.* and yahoo.* across country-code TLDs', () => {
		expect(isFreemailDomain('gmx.de')).toBe(true);
		expect(isFreemailDomain('gmx.net')).toBe(true);
		expect(isFreemailDomain('gmx.co.uk')).toBe(true);
		expect(isFreemailDomain('yahoo.co.uk')).toBe(true);
		expect(isFreemailDomain('yahoo.fr')).toBe(true);
	});

	it('normalizes case, whitespace and a trailing dot', () => {
		expect(isFreemailDomain('  GMAIL.COM  ')).toBe(true);
		expect(isFreemailDomain('gmail.com.')).toBe(true);
	});

	it('does not flag domains the user can own', () => {
		for (const domain of [
			'example.com',
			'mail.example.com',
			'acme.io',
			'notgmail.com',
			'gmailx.com',
		]) {
			expect(isFreemailDomain(domain)).toBe(false);
		}
	});

	it('returns false for empty or label-less input', () => {
		expect(isFreemailDomain('')).toBe(false);
		expect(isFreemailDomain('   ')).toBe(false);
		expect(isFreemailDomain('localhost')).toBe(false);
	});
});

describe('resolveNs', () => {
	it('returns true when NS records are present', async () => {
		mockDoh({ Status: 0, Answer: [{ type: 2, data: 'ns1.example.com.' }] });
		expect(await resolveNs('example.com')).toBe(true);
	});

	it('returns false on NXDOMAIN (no such domain)', async () => {
		mockDoh({ Status: 3 });
		expect(await resolveNs('nope-does-not-exist.com')).toBe(false);
	});

	it('returns null (silent) for NOERROR without NS answers (e.g. a subdomain)', async () => {
		mockDoh({ Status: 0, Answer: [] });
		expect(await resolveNs('mail.example.com')).toBeNull();
	});

	it('returns null (fail-soft) when fetch rejects — never throws', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
		await expect(resolveNs('example.com')).resolves.toBeNull();
	});

	it('returns null (fail-soft) on a non-2xx DoH response', async () => {
		mockDoh({}, false);
		expect(await resolveNs('example.com')).toBeNull();
	});

	it('returns null for empty / label-less input without hitting the network', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(await resolveNs('')).toBeNull();
		expect(await resolveNs('localhost')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
