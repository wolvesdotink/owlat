import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightMtaIdentities } from '../mtaIdentityPreflight';

function baseEnv(overrides: Record<string, string> = {}) {
	return {
		IP_POOLS_TRANSACTIONAL: '203.0.113.10',
		IP_POOLS_CAMPAIGN: '203.0.113.10',
		EHLO_HOSTNAME: 'mail.example.com',
		...overrides,
	};
}

describe('preflightMtaIdentities', () => {
	afterEach(() => vi.useRealTimers());

	it('refuses completion and names the exact Hetzner PTR to configure', async () => {
		const result = await preflightMtaIdentities(baseEnv(), {
			reverse: vi.fn(async () => ['static.203-0-113-10.clients.your-server.de']),
			resolve4: vi.fn(async () => ['203.0.113.10']),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('Set its PTR exactly to mail.example.com');
		expect(result.message).toContain('Hetzner Console');
	});

	it('reports every failing identity in one preflight response', async () => {
		const result = await preflightMtaIdentities(baseEnv({ IP_POOLS_CAMPAIGN: '203.0.113.11' }), {
			reverse: vi.fn(async () => {
				throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
			}),
			resolve4: vi.fn(),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('203.0.113.10');
		expect(result.message).toContain('203.0.113.11');
	});

	it('returns after the shared DNS budget when a resolver never settles', async () => {
		vi.useFakeTimers();
		const resultPromise = preflightMtaIdentities(baseEnv(), {
			reverse: vi.fn(() => new Promise<string[]>(() => {})),
			resolve4: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await expect(resultPromise).resolves.toMatchObject({ ok: false });
	});

	it('passes all unique pool IPs only after live PTR/forward/EHLO confirmation', async () => {
		const result = await preflightMtaIdentities(
			baseEnv({
				IP_POOLS_CAMPAIGN: '203.0.113.11',
				EHLO_HOSTNAMES: JSON.stringify({ '203.0.113.11': 'mail2.example.com' }),
			}),
			{
				reverse: vi.fn(async (ip: string) => [
					ip.endsWith('.10') ? 'mail.example.com' : 'mail2.example.com',
				]),
				resolve4: vi.fn(async (name: string) => [
					name === 'mail.example.com' ? '203.0.113.10' : '203.0.113.11',
				]),
			}
		);
		expect(result.ok).toBe(true);
		expect(result.identities).toHaveLength(2);
	});

	it('allows a failed lab identity only through the explicit override', async () => {
		const result = await preflightMtaIdentities(baseEnv({ MTA_ALLOW_UNVERIFIED_FCRDNS: 'true' }), {
			reverse: vi.fn(async () => {
				throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
			}),
			resolve4: vi.fn(),
		});
		expect(result).toMatchObject({ ok: true });
		expect(result.identities[0]).toMatchObject({ verdict: 'fail', overridden: true });
	});

	it('keeps IPv6 opt-in explicit and validates it through AAAA', async () => {
		const mixed = baseEnv({
			MTA_IPV6_ENABLED: 'true',
			IP_POOLS_CAMPAIGN: '203.0.113.10,2001:0DB8:0:0:0:0:0:10',
			EHLO_HOSTNAMES: JSON.stringify({ '2001:db8::10': 'mail6.example.com' }),
		});
		const deps = {
			reverse: vi.fn(async (ip: string) => [
				ip.includes(':') ? 'mail6.example.com' : 'mail.example.com',
			]),
			resolve4: vi.fn(async () => ['203.0.113.10']),
			resolve6: vi.fn(async () => ['2001:db8::10']),
		};
		expect(await preflightMtaIdentities(mixed, deps)).toMatchObject({ ok: true });
		expect(deps.resolve6).toHaveBeenCalledWith('mail6.example.com');

		expect(
			await preflightMtaIdentities({ ...mixed, MTA_IPV6_ENABLED: 'false' }, deps)
		).toMatchObject({ ok: false, message: expect.stringContaining('explicit') });
	});

	it('does not let the IPv4 lab override unlock IPv6', async () => {
		const result = await preflightMtaIdentities(
			baseEnv({
				MTA_IPV6_ENABLED: 'true',
				MTA_ALLOW_UNVERIFIED_FCRDNS: 'true',
				IP_POOLS_CAMPAIGN: '203.0.113.10,2001:db8::10',
				EHLO_HOSTNAMES: JSON.stringify({ '2001:db8::10': 'mail6.example.com' }),
			}),
			{
				reverse: vi.fn(async (ip: string) => {
					if (ip.includes(':')) return ['mail6.example.com'];
					throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
				}),
				resolve4: vi.fn(),
				resolve6: vi.fn(async () => ['2001:db8::10']),
			}
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('every configured IPv4 identity');
	});
});
