import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	destinationFromMx,
	providerFromMxHostnames,
	resolveDestinationSnapshot,
} from '../destinationProvider.js';
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
		const lookup = vi.fn(async (domain: string) => [
			{ exchange: `${domain}.aspmx.l.google.com`, priority: 1 },
		]);
		const first = await resolveDestinationSnapshot(redis, 'alpha.example', {
			normalMxLookup: lookup,
		});
		const second = await resolveDestinationSnapshot(redis, 'beta.example', {
			normalMxLookup: lookup,
		});

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

	it('derives policy and delivery hosts from one immutable MX snapshot', async () => {
		const redis = new Redis() as unknown as RealRedis;
		const lookup = vi
			.fn()
			.mockResolvedValueOnce([{ exchange: 'mx.partner.example', priority: 0 }])
			.mockResolvedValueOnce([{ exchange: 'aspmx.l.google.com', priority: 0 }]);

		const original = await resolveDestinationSnapshot(redis, 'tenant.example', {
			normalMxLookup: lookup,
		});
		expect(original).toMatchObject({
			providerKey: 'other',
			mx: { hosts: [{ exchange: 'mx.partner.example' }] },
		});

		// A caller that passes this snapshot to delivery cannot independently
		// re-resolve provider policy against a newer, different DNS response.
		expect(destinationFromMx(original.recipientDomain, original.mx)).toEqual(original);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it('classifies DANE-discovered MX hosts in the same snapshot', () => {
		const snapshot = destinationFromMx(
			'workspace.example',
			{
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'aspmx.l.google.com', priority: 10 }],
			},
			{
				daneDiscoveryAuthenticated: true,
				daneDestinations: [
					{
						mxHostname: 'aspmx.l.google.com',
						preference: 10,
						mxSecurity: 'secure',
						addressSecurity: 'secure',
						addresses: ['192.0.2.1'],
					},
				],
			}
		);

		expect(snapshot.providerKey).toBe('gmail');
		expect(snapshot.throttleKey).toBe('gmail');
		expect(snapshot.daneDestinations?.[0]?.mxHostname).toBe(
			snapshot.mx.status === 'deliverable' ? snapshot.mx.hosts[0]?.exchange : undefined
		);
	});
});
