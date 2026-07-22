import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const canSend = vi.hoisted(() => vi.fn());
const canSendScope = vi.hoisted(() => vi.fn());
const relayAllowed = vi.hoisted(() => vi.fn());
const reserveProbe = vi.hoisted(() => vi.fn());
const reserveWarmingSlot = vi.hoisted(() => vi.fn());

vi.mock('../../intelligence/circuitBreaker.js', () => ({
	canSend,
	canSendScope,
	isRelayAllowedByGlobalBreaker: relayAllowed,
	reserveHalfOpenProbe: reserveProbe,
	releaseHalfOpenProbe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../intelligence/warming.js', () => ({
	reserveWarmingSlot,
	releaseWarmingSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../smtp/destinationProvider.js', () => ({
	resolveDestinationSnapshot: vi.fn().mockResolvedValue({ providerKey: 'gmail' }),
}));
vi.mock('../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn().mockResolvedValue({ pool: 'campaign' }),
}));
vi.mock('../../scaling/ipPool.js', () => ({
	selectIpWithLease: vi.fn().mockResolvedValue({ ip: '192.0.2.10', eligibilityGeneration: 1 }),
}));

const { createRoutingDecisionHandler } = await import('../routingDecision.js');

const closed = { allowed: true, state: 'closed' as const, generation: 1 };
const input = {
	messageId: 'send-1',
	workAttemptId: 'work-1',
	routingReentryToken: 'reentry-1',
	startedAt: Date.now(),
	deliveryDomain: 'production',
	messageType: 'campaign',
	organizationId: 'org-1',
	recipient: 'person@gmail.com',
	from: 'sender@example.org',
	candidateProvider: 'mta',
	ipPool: 'campaign',
	allowWarmupOverflow: false,
};

async function decide(overrides: Record<string, unknown> = {}) {
	const redis = { set: vi.fn().mockResolvedValue('OK'), del: vi.fn() } as unknown as Redis;
	const app = new Hono();
	app.use('/send/decision', async (c, next) => {
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post('/send/decision', createRoutingDecisionHandler(redis, { ipPools: {} } as MtaConfig));
	const response = await app.request('/send/decision', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...input, ...overrides }),
	});
	return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
	vi.clearAllMocks();
	canSend.mockResolvedValue(closed);
	canSendScope.mockResolvedValue(closed);
	relayAllowed.mockResolvedValue(false);
	reserveProbe.mockResolvedValue(true);
	reserveWarmingSlot.mockResolvedValue({ allowed: true, reservation: undefined });
});

describe('global breaker dominance over relay fallback', () => {
	it.each([
		['candidate relay', { candidateProvider: 'relay' }, () => undefined],
		[
			'provider breaker',
			{},
			() => canSendScope.mockResolvedValue({ allowed: false, state: 'open', generation: 2 }),
		],
		[
			'warming overflow',
			{ allowWarmupOverflow: true },
			() => reserveWarmingSlot.mockResolvedValue({ allowed: false, sentToday: 10, dailyCap: 10 }),
		],
		[
			'provider probe exhaustion',
			{},
			() => {
				canSendScope.mockResolvedValue({ allowed: true, state: 'half-open', generation: 2 });
				reserveProbe.mockResolvedValue(false);
			},
		],
	] as const)(
		'defers %s unless the atomic guard proves exact closed',
		async (_name, overrides, setup) => {
			setup();
			expect(await decide(overrides)).toMatchObject({ decision: 'defer', reason: 'global_safety' });
			expect(relayAllowed).toHaveBeenCalled();
		}
	);

	it('permits provider fallback only when the atomic guard returns closed', async () => {
		canSendScope.mockResolvedValue({ allowed: false, state: 'open', generation: 2 });
		relayAllowed.mockResolvedValue(true);
		expect(await decide()).toEqual({ decision: 'relay', reason: 'provider_breaker' });
	});

	it('allows the owned global half-open probe path to proceed to MTA', async () => {
		canSend.mockResolvedValue({ allowed: true, state: 'half-open', generation: 3 });
		expect(await decide()).toMatchObject({ decision: 'mta' });
		expect(reserveProbe).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			undefined,
			'send-1',
			expect.any(Number),
			3
		);
	});

	it('keeps member tests behind global and destination-provider breakers', async () => {
		canSend.mockResolvedValueOnce({
			allowed: false,
			state: 'open',
			generation: 2,
			retryAfter: 30_000,
		});
		expect(await decide({ deliveryDomain: 'member_test' })).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});

		canSendScope.mockResolvedValueOnce({ allowed: false, state: 'open', generation: 2 });
		expect(await decide({ deliveryDomain: 'member_test' })).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});
	});

	it('never reserves persistent warming capacity for a member test', async () => {
		expect(
			await decide({ deliveryDomain: 'member_test', allowWarmupOverflow: true })
		).toMatchObject({ decision: 'mta' });
		expect(reserveWarmingSlot).not.toHaveBeenCalled();
	});
});
