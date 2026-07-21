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
});
