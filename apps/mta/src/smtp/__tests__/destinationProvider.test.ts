import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { resolveDestinationIdentity, providerFromMxHostnames } from '../destinationProvider.js';
import { acquireSlot } from '../../intelligence/domainThrottle.js';
import { setProfile } from '../../config/ispProfiles.js';
import { buildGroupKey } from '../../queue/groups.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MX-derived destination provider identity', () => {
	it('matches provider suffixes on DNS label boundaries', () => {
		expect(providerFromMxHostnames(['aspmx.l.google.com.'])).toBe('gmail');
		expect(providerFromMxHostnames(['tenant.mail.protection.outlook.com'])).toBe('microsoft');
		expect(providerFromMxHostnames(['mx-biz.mail.am0.yahoodns.net'])).toBe('yahoo');
		expect(providerFromMxHostnames(['google.com.attacker.example'])).toBe('other');
		expect(providerFromMxHostnames(['aspmx.l.google.com', 'mx.attacker.example'])).toBe('other');
	});

	it('rolls Workspace domains into one Gmail throttle bucket without changing queue FIFO groups', async () => {
		const redis = new Redis() as unknown as RealRedis;
		const lookup = vi.fn(async (_redis: RealRedis, domain: string) => [
			{ exchange: `${domain}.aspmx.l.google.com`, priority: 1 },
		]);
		const first = await resolveDestinationIdentity(redis, 'alpha.example', lookup);
		const second = await resolveDestinationIdentity(redis, 'beta.example', lookup);

		expect(first.throttleKey).toBe('gmail');
		expect(second.throttleKey).toBe('gmail');
		expect(buildGroupKey('campaign', first.recipientDomain)).toBe('campaign:alpha.example');
		expect(buildGroupKey('campaign', second.recipientDomain)).toBe('campaign:beta.example');

		await setProfile(redis, 'gmail', { defaultRate: 1, ceiling: 1, floor: 1 });
		expect(await acquireSlot(redis, '192.0.2.10', first.throttleKey, first.providerKey)).toBe(true);
		expect(await acquireSlot(redis, '192.0.2.10', second.throttleKey, second.providerKey)).toBe(
			false
		);
	});

	it('does not cache an unknown provider when MX lookup returns no records', async () => {
		const redis = new Redis() as unknown as RealRedis;
		const lookup = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ exchange: 'aspmx.l.google.com', priority: 1 }]);

		expect((await resolveDestinationIdentity(redis, 'transient.example', lookup)).providerKey).toBe(
			'other'
		);
		expect((await resolveDestinationIdentity(redis, 'transient.example', lookup)).providerKey).toBe(
			'gmail'
		);
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it('ignores a malformed cached provider value', async () => {
		const redis = new Redis() as unknown as RealRedis;
		await redis.set('mta:destination-provider:v1:tenant.example', 'gmail:poisoned');
		const lookup = vi
			.fn()
			.mockResolvedValue([{ exchange: 'tenant.mail.protection.outlook.com', priority: 0 }]);
		expect((await resolveDestinationIdentity(redis, 'tenant.example', lookup)).providerKey).toBe(
			'microsoft'
		);
	});
});
