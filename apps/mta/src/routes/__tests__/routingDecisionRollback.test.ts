import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const releaseHalfOpenProbe = vi.fn().mockResolvedValue(undefined);
const releaseWarmingSlot = vi.fn().mockResolvedValue(undefined);
vi.mock('../../intelligence/circuitBreaker.js', () => ({
	canSend: vi.fn().mockResolvedValue({ allowed: true, state: 'half-open', generation: 4 }),
	canSendScope: vi.fn().mockResolvedValue({ allowed: true, state: 'half-open', generation: 7 }),
	reserveHalfOpenProbe: vi.fn().mockResolvedValue(true),
	releaseHalfOpenProbe,
}));
vi.mock('../../intelligence/warming.js', () => ({
	reserveWarmingSlot: vi.fn().mockResolvedValue({
		allowed: true,
		reservation: {
			ip: '192.0.2.10',
			messageId: 'send-1',
			utcDate: '2026-07-22',
			expiresAt: Date.now() + 60_000,
		},
	}),
	releaseWarmingSlot,
}));
vi.mock('../../smtp/destinationProvider.js', () => ({
	resolveDestinationSnapshot: vi.fn().mockResolvedValue({ providerKey: 'gmail' }),
}));
vi.mock('../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn().mockResolvedValue({ pool: 'campaign' }),
}));
vi.mock('../../scaling/ipPool.js', () => ({
	selectIpWithLease: vi.fn().mockResolvedValue({ ip: '192.0.2.10', eligibilityGeneration: 2 }),
}));

const { createRoutingDecisionHandler } = await import('../routingDecision.js');

const request = {
	messageId: 'send-1',
	messageType: 'campaign',
	organizationId: 'org-1',
	recipient: 'person@gmail.com',
	from: 'sender@example.org',
	candidateProvider: 'mta',
	ipPool: 'campaign',
	allowWarmupOverflow: true,
};

function context(json: ReturnType<typeof vi.fn>): Context {
	return {
		req: { json: vi.fn().mockResolvedValue(request) },
		get: vi.fn().mockReturnValue({ isMasterKey: true }),
		json,
	} as unknown as Context;
}

beforeEach(() => {
	releaseHalfOpenProbe.mockClear();
	releaseWarmingSlot.mockClear();
});

describe('routing-decision reservation rollback', () => {
	it('releases warming and both half-open probes when lease persistence fails', async () => {
		const redis = {
			set: vi.fn().mockResolvedValue(null),
			del: vi.fn().mockResolvedValue(1),
		} as unknown as Redis;
		const json = vi.fn((body: unknown) => body);

		const result = await createRoutingDecisionHandler(redis, {} as MtaConfig)(context(json));

		expect(result).toMatchObject({ decision: 'defer', reason: 'lease_persistence' });
		expect(releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
		expect(releaseWarmingSlot).toHaveBeenCalledOnce();
		expect((redis.del as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it('deletes the lease and releases reservations when response construction fails', async () => {
		const redis = {
			set: vi.fn().mockResolvedValue('OK'),
			del: vi.fn().mockResolvedValue(1),
		} as unknown as Redis;
		const json = vi.fn((body: { decision: string }) => {
			if (body.decision === 'mta') throw new Error('response failure');
			return body;
		});

		const result = await createRoutingDecisionHandler(redis, {} as MtaConfig)(context(json));

		expect(result).toMatchObject({ decision: 'defer', reason: 'lease_persistence' });
		expect(redis.del).toHaveBeenCalledOnce();
		expect(releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
		expect(releaseWarmingSlot).toHaveBeenCalledOnce();
	});
});
