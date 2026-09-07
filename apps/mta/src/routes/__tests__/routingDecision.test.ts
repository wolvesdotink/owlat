import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

const breaker = vi.hoisted(() => ({
	canSend: vi.fn(),
	canSendScope: vi.fn(),
	isRelayAllowedByGlobalBreaker: vi.fn(),
	reserveHalfOpenProbe: vi.fn(),
	releaseHalfOpenProbe: vi.fn(),
}));
const warming = vi.hoisted(() => ({
	reserveWarmingSlot: vi.fn(),
	releaseWarmingSlot: vi.fn(),
}));

vi.mock('../../intelligence/circuitBreaker.js', () => breaker);
vi.mock('../../intelligence/warming.js', () => warming);
vi.mock('../../smtp/destinationProvider.js', () => ({
	resolveDestinationSnapshot: vi.fn().mockResolvedValue({ providerKey: 'gmail' }),
}));
vi.mock('../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn().mockResolvedValue({ pool: 'campaign' }),
}));
vi.mock('../../scaling/ipPool.js', () => ({
	selectIpWithLease: vi.fn().mockResolvedValue({ ip: '192.0.2.10', eligibilityGeneration: 1 }),
}));

const actualBreaker = await vi.importActual<typeof import('../../intelligence/circuitBreaker.js')>(
	'../../intelligence/circuitBreaker.js'
);
const { createRoutingDecisionHandler, isRoutingLeaseBoundTo, readRoutingLease } =
	await import('../routingDecision.js');
type RoutingLeaseRecord = import('../routingDecision.js').RoutingLeaseRecord;

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

function lease(overrides: Partial<RoutingLeaseRecord> = {}): RoutingLeaseRecord {
	return {
		token: 'lease-1',
		messageId: 'message-1',
		workAttemptId: 'work-1',
		routingReentryToken: 'reentry-1',
		startedAt: 1_000,
		deliveryDomain: 'production',
		organizationId: 'org-1',
		recipient: 'user@example.com',
		from: 'sender@example.org',
		messageType: 'campaign',
		candidateProvider: 'mta',
		ipPool: 'campaign',
		allowWarmupOverflow: false,
		destinationProvider: 'gmail',
		probe: false,
		globalProbe: false,
		globalBreakerGeneration: 0,
		expiresAt: 10_000,
		...overrides,
	};
}

const boundInput = {
	messageId: 'message-1',
	workAttemptId: 'work-1',
	routingReentryToken: 'reentry-1',
	startedAt: 1_000,
	deliveryDomain: 'production' as const,
	messageType: 'campaign' as const,
	organizationId: 'org-1',
	recipient: 'user@example.com',
	from: 'sender@example.org',
	candidateProvider: 'mta' as const,
	ipPool: 'campaign' as const,
	allowWarmupOverflow: false,
};

function persistingRedis(setResult: string | null = 'OK'): Redis {
	return {
		set: vi.fn().mockResolvedValue(setResult),
		del: vi.fn().mockResolvedValue(1),
	} as unknown as Redis;
}

/** POST the decision request through the Hono handler and return the JSON body. */
async function decide(
	overrides: Record<string, unknown> = {},
	redis: Redis = persistingRedis(),
	config: MtaConfig = { ipPools: {} } as MtaConfig
) {
	const app = new Hono();
	app.use('/send/decision', async (c, next) => {
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post('/send/decision', createRoutingDecisionHandler(redis, config));
	const response = await app.request('/send/decision', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...input, ...overrides }),
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
	vi.clearAllMocks();
	breaker.canSend.mockResolvedValue(closed);
	breaker.canSendScope.mockResolvedValue(closed);
	breaker.isRelayAllowedByGlobalBreaker.mockResolvedValue(false);
	breaker.reserveHalfOpenProbe.mockResolvedValue(true);
	breaker.releaseHalfOpenProbe.mockResolvedValue(undefined);
	warming.reserveWarmingSlot.mockResolvedValue({ allowed: true, reservation: undefined });
	warming.releaseWarmingSlot.mockResolvedValue(undefined);
});

describe('routing decision lease binding', () => {
	it('accepts only the exact tenant, message, and recipient before expiry', () => {
		expect(
			isRoutingLeaseBoundTo(lease(), { ...boundInput, recipient: 'USER@example.com' }, 9_000)
		).toBe(true);
	});

	it.each([
		{ messageId: 'other', organizationId: 'org-1', recipient: 'user@example.com' },
		{ messageId: 'message-1', organizationId: 'org-2', recipient: 'user@example.com' },
		{ messageId: 'message-1', organizationId: 'org-1', recipient: 'other@example.com' },
		{ from: 'other@example.org' },
		{ messageType: 'automation' as const },
		{ ipPool: 'transactional' as const },
		{ allowWarmupOverflow: true },
		{ workAttemptId: 'work-2' },
		{ routingReentryToken: 'reentry-2' },
		{ startedAt: 999 },
		{ deliveryDomain: 'member_test' as const },
	])('rejects cross-message, cross-tenant, and cross-recipient replay', (override) => {
		expect(isRoutingLeaseBoundTo(lease(), { ...boundInput, ...override }, 9_000)).toBe(false);
	});

	it('rejects an expired lease', () => {
		expect(isRoutingLeaseBoundTo(lease(), boundInput, 10_001)).toBe(false);
	});
});

/**
 * The three answers a lease read may give (issue #505). `readRoutingLease` used
 * to collapse all of them into `null`, which made "our Redis lost the record"
 * indistinguishable from "the decision is stale" one layer up — and only the
 * second of those is evidence about the sending identity.
 */
describe('routing lease reads', () => {
	function redisReturning(value: string | null): Redis {
		return { get: vi.fn().mockResolvedValue(value) } as unknown as Redis;
	}

	it('returns the record while it is still current', async () => {
		const record = lease({ expiresAt: Date.now() + 60_000 });
		expect(await readRoutingLease(redisReturning(JSON.stringify(record)), 'lease-1')).toEqual({
			status: 'ok',
			lease: record,
		});
	});

	it('reports a readable record past its own deadline as expired', async () => {
		const stored = JSON.stringify(lease({ expiresAt: Date.now() - 1 }));
		expect(await readRoutingLease(redisReturning(stored), 'lease-1')).toEqual({
			status: 'expired',
		});
	});

	// A missing key is the 15-minute TTL elapsing in the ordinary case and an
	// eviction/flush/empty-replica failover in the rare one, and a `GET` cannot
	// tell them apart. `absent` keeps the stale-decision reading rather than
	// claiming a storage fault it cannot prove.
	it('reports a key Redis no longer has as absent, not as a storage fault', async () => {
		expect(await readRoutingLease(redisReturning(null), 'lease-1')).toEqual({ status: 'absent' });
	});

	it.each([
		['a truncated value', '{"token":"lease-1","messa'],
		['a value that is not an object', '42'],
		['an array', '[]'],
		['a record naming another token', JSON.stringify(lease({ token: 'lease-2' }))],
		['a record with no usable deadline', JSON.stringify(lease({ expiresAt: Number.NaN }))],
	])('reports %s as unreadable', async (_label, stored) => {
		expect(await readRoutingLease(redisReturning(stored), 'lease-1')).toEqual({
			status: 'unreadable',
		});
	});
});

describe('global breaker dominance over relay fallback', () => {
	it.each([
		['candidate relay', { candidateProvider: 'relay' }, () => undefined],
		[
			'provider breaker',
			{},
			() =>
				breaker.canSendScope.mockResolvedValue({ allowed: false, state: 'open', generation: 2 }),
		],
		[
			'warming overflow',
			{ allowWarmupOverflow: true },
			() =>
				warming.reserveWarmingSlot.mockResolvedValue({
					allowed: false,
					sentToday: 10,
					dailyCap: 10,
				}),
		],
		[
			'provider probe exhaustion',
			{},
			() => {
				breaker.canSendScope.mockResolvedValue({
					allowed: true,
					state: 'half-open',
					generation: 2,
				});
				breaker.reserveHalfOpenProbe.mockResolvedValue(false);
			},
		],
	] as const)(
		'defers %s unless the atomic guard proves exact closed',
		async (_name, overrides, setup) => {
			setup();
			expect(await decide(overrides)).toMatchObject({ decision: 'defer', reason: 'global_safety' });
			expect(breaker.isRelayAllowedByGlobalBreaker).toHaveBeenCalled();
		}
	);

	it('permits provider fallback only when the atomic guard returns closed', async () => {
		breaker.canSendScope.mockResolvedValue({ allowed: false, state: 'open', generation: 2 });
		breaker.isRelayAllowedByGlobalBreaker.mockResolvedValue(true);
		expect(await decide()).toEqual({ decision: 'relay', reason: 'provider_breaker' });
	});

	it('allows the owned global half-open probe path to proceed to MTA', async () => {
		breaker.canSend.mockResolvedValue({ allowed: true, state: 'half-open', generation: 3 });
		expect(await decide()).toMatchObject({ decision: 'mta' });
		expect(breaker.reserveHalfOpenProbe).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			undefined,
			'send-1',
			expect.any(Number),
			3
		);
	});

	it.each([
		['ordinary closed route', closed],
		['unrelated global probe', { allowed: true, state: 'half-open' as const, generation: 3 }],
	] as const)('keeps Convex hysteresis on relay for an %s', async (_label, globalState) => {
		breaker.canSendScope.mockResolvedValue(closed);
		breaker.canSend.mockResolvedValue(globalState);
		expect(await decide({ requireProviderProbe: true })).toEqual({
			decision: 'relay',
			reason: 'provider_hysteresis',
		});
		expect(breaker.reserveHalfOpenProbe).not.toHaveBeenCalled();
	});

	it('returns an explicit persisted provider-probe lease during hysteresis', async () => {
		breaker.canSendScope.mockResolvedValue({ allowed: true, state: 'half-open', generation: 4 });
		const decision = await decide({ requireProviderProbe: true });
		expect(decision).toMatchObject({
			decision: 'mta',
			lease: { providerProbe: true, globalProbe: false },
		});
		expect(breaker.reserveHalfOpenProbe).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			'gmail',
			'send-1',
			expect.any(Number),
			4
		);
	});

	it('keeps member tests behind global and destination-provider breakers', async () => {
		breaker.canSend.mockResolvedValueOnce({
			allowed: false,
			state: 'open',
			generation: 2,
			retryAfter: 30_000,
		});
		expect(await decide({ deliveryDomain: 'member_test' })).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});

		breaker.canSendScope.mockResolvedValueOnce({ allowed: false, state: 'open', generation: 2 });
		expect(await decide({ deliveryDomain: 'member_test' })).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});
	});

	it('never reserves persistent warming capacity for a member test', async () => {
		expect(
			await decide({ deliveryDomain: 'member_test', allowWarmupOverflow: true })
		).toMatchObject({ decision: 'mta' });
		expect(warming.reserveWarmingSlot).not.toHaveBeenCalled();
	});
});

describe('global breaker precedence during a provider check', () => {
	// The real breaker reads its state from Redis; this case is about the
	// ordering of those reads, so the mocked exports delegate to the real module.
	beforeEach(() => {
		breaker.canSend.mockImplementation(actualBreaker.canSend);
		breaker.canSendScope.mockImplementation(actualBreaker.canSendScope);
		breaker.isRelayAllowedByGlobalBreaker.mockImplementation(
			actualBreaker.isRelayAllowedByGlobalBreaker
		);
		breaker.reserveHalfOpenProbe.mockImplementation(actualBreaker.reserveHalfOpenProbe);
		breaker.releaseHalfOpenProbe.mockImplementation(actualBreaker.releaseHalfOpenProbe);
	});

	it('defers when global opens during a provider check instead of mapping it to relay', async () => {
		let breakerRead = 0;
		const redis = {
			hgetall: vi.fn(async (key: string) => {
				if (!key.includes(':state')) return {};
				breakerRead += 1;
				if (breakerRead === 3) {
					return { status: 'open', cooldownUntil: String(Date.now() + 90_000), generation: '3' };
				}
				return {};
			}),
		} as unknown as Redis;

		expect(await decide({}, redis, {} as MtaConfig)).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});
	});
});

describe('reservation rollback', () => {
	const rollbackRequest = { ...input, allowWarmupOverflow: true };

	function context(json: ReturnType<typeof vi.fn>): Context {
		return {
			req: { json: vi.fn().mockResolvedValue(rollbackRequest) },
			get: vi.fn().mockReturnValue({ isMasterKey: true }),
			json,
		} as unknown as Context;
	}

	beforeEach(() => {
		breaker.canSend.mockResolvedValue({ allowed: true, state: 'half-open', generation: 4 });
		breaker.canSendScope.mockResolvedValue({ allowed: true, state: 'half-open', generation: 7 });
		warming.reserveWarmingSlot.mockResolvedValue({
			allowed: true,
			reservation: {
				ip: '192.0.2.10',
				messageId: 'send-1',
				utcDate: '2026-07-22',
				expiresAt: Date.now() + 60_000,
			},
		});
	});

	it('releases warming and both half-open probes when lease persistence fails', async () => {
		const redis = persistingRedis(null);
		const json = vi.fn((body: unknown) => body);

		const result = await createRoutingDecisionHandler(redis, {} as MtaConfig)(context(json));

		expect(result).toMatchObject({ decision: 'defer', reason: 'lease_persistence' });
		expect(breaker.releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
		expect(warming.releaseWarmingSlot).toHaveBeenCalledOnce();
		expect(redis.del).toHaveBeenCalledOnce();
	});

	it('deletes the lease and releases reservations when response construction fails', async () => {
		const redis = persistingRedis();
		const json = vi.fn((body: { decision: string }) => {
			if (body.decision === 'mta') throw new Error('response failure');
			return body;
		});

		const result = await createRoutingDecisionHandler(redis, {} as MtaConfig)(context(json));

		expect(result).toMatchObject({ decision: 'defer', reason: 'lease_persistence' });
		expect(redis.del).toHaveBeenCalledOnce();
		expect(breaker.releaseHalfOpenProbe).toHaveBeenCalledTimes(2);
		expect(warming.releaseWarmingSlot).toHaveBeenCalledOnce();
	});
});
