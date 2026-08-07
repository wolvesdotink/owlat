/**
 * Wire-compat, MTA half: the handlers still produce and accept the SAME BYTES.
 *
 * D7 moved the Convex<->MTA contract into `@owlat/mta-protocol` and typed both
 * ends against it; the stated risk is that TS narrowing silently changes wire
 * semantics. This suite drives the SHIPPED handlers and compares their raw
 * response text against the frozen fixtures in
 * `@owlat/mta-protocol/wireFixtures` — the very module
 * `apps/api/convex/lib/sendProviders/__tests__/mtaWireCompat.test.ts` pins the
 * other end to, so the two ends cannot drift into agreeing with themselves and
 * disagreeing with each other.
 *
 * Raw TEXT, never a parsed object: key order is part of the contract Convex
 * validates by exact key count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { Queue } from 'groupmq';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import {
	DECISION_DEFER_BYTES,
	DECISION_MTA_BYTES,
	DECISION_RELAY_ALLOWED_BYTES,
	DECISION_RELAY_REASON_BYTES,
	GOVERNED_SEND_REQUEST_BYTES,
	SEND_ACCEPTED_BYTES,
	SEND_DEDUPLICATED_BYTES,
	SEND_INTAKE_PENDING_BYTES,
	SEND_LEASE_REQUIRED_BYTES,
} from '@owlat/mta-protocol/wireFixtures';

const canSend = vi.hoisted(() => vi.fn());
const canSendScope = vi.hoisted(() => vi.fn());
const relayAllowed = vi.hoisted(() => vi.fn());
const reserveProbe = vi.hoisted(() => vi.fn());
const reserveWarmingSlot = vi.hoisted(() => vi.fn());
const selectIpWithLease = vi.hoisted(() => vi.fn());

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
	selectIpWithLease,
	isIpEligibilityLeaseValid: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../scaling/degradation.js', () => ({
	checkSystemHealth: vi
		.fn()
		.mockResolvedValue({ redisHealthy: true, backpressure: false, allIpsBlocked: false }),
}));

const { createRoutingDecisionHandler } = await import('../routingDecision.js');
const { createSendHandler } = await import('../send.js');

const REQUEST = JSON.parse(GOVERNED_SEND_REQUEST_BYTES) as {
	messageId: string;
	workAttemptId: string;
	routingReentryToken: string;
	routingReentry: { retryState: { startedAt: number } };
	to: string;
	organizationId: string;
	messageType: string;
	deliveryDomain: string;
	ipPool: string;
	allowWarmupOverflow: boolean;
	routingLease: string;
};

/** A moment just inside the governed message-age window of the fixture. */
const NOW = REQUEST.routingReentry.retryState.startedAt + 1_000;

const closed = { allowed: true, state: 'closed' as const, generation: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	canSend.mockResolvedValue(closed);
	canSendScope.mockResolvedValue(closed);
	relayAllowed.mockResolvedValue(false);
	reserveProbe.mockResolvedValue(true);
	reserveWarmingSlot.mockResolvedValue({ allowed: true, reservation: undefined });
	selectIpWithLease.mockResolvedValue({ ip: '192.0.2.10', eligibilityGeneration: 1 });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ─── POST /send/decision ───────────────────────────────────────────────────

async function decide(overrides: Record<string, unknown> = {}): Promise<string> {
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
		body: JSON.stringify({
			messageId: REQUEST.messageId,
			workAttemptId: REQUEST.workAttemptId,
			routingReentryToken: REQUEST.routingReentryToken,
			startedAt: Date.now(),
			deliveryDomain: 'production',
			messageType: 'campaign',
			organizationId: REQUEST.organizationId,
			recipient: REQUEST.to,
			from: 'sender@mail.example.org',
			candidateProvider: 'mta',
			ipPool: 'campaign',
			allowWarmupOverflow: false,
			...overrides,
		}),
	});
	return response.text();
}

describe('routing decision answers', () => {
	it('grants a lease with the frozen mta answer bytes', async () => {
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('lease-fixture-1');
		expect(await decide()).toBe(DECISION_MTA_BYTES);
	});

	it('answers a relay candidate with the frozen reason-less relay bytes', async () => {
		relayAllowed.mockResolvedValue(true);
		expect(await decide({ candidateProvider: 'relay' })).toBe(DECISION_RELAY_ALLOWED_BYTES);
	});

	it('answers an open provider breaker with the frozen relay bytes', async () => {
		relayAllowed.mockResolvedValue(true);
		canSendScope.mockResolvedValue({ allowed: false, state: 'open', generation: 0 });
		expect(await decide()).toBe(DECISION_RELAY_REASON_BYTES.provider_breaker);
	});

	it('answers a hysteresis hold with the frozen relay bytes', async () => {
		canSendScope.mockResolvedValue({ ...closed, state: 'closed' });
		expect(await decide({ requireProviderProbe: true })).toBe(
			DECISION_RELAY_REASON_BYTES.provider_hysteresis
		);
	});

	it('answers a spent warm-up overflow with the frozen relay bytes', async () => {
		relayAllowed.mockResolvedValue(true);
		reserveWarmingSlot.mockResolvedValue({ allowed: false });
		expect(await decide({ allowWarmupOverflow: true })).toBe(
			DECISION_RELAY_REASON_BYTES.warmup_overflow
		);
	});

	it('answers a spent provider probe budget with the frozen relay bytes', async () => {
		relayAllowed.mockResolvedValue(true);
		canSendScope.mockResolvedValue({ allowed: true, state: 'half-open', generation: 0 });
		reserveProbe.mockResolvedValue(false);
		expect(await decide()).toBe(DECISION_RELAY_REASON_BYTES.provider_probe_limit);
	});

	it('answers an open global breaker with the frozen defer bytes', async () => {
		canSend.mockResolvedValue({ allowed: false, state: 'open', generation: 0 });
		expect(await decide()).toBe(DECISION_DEFER_BYTES.global_safety);
	});

	it('answers a spent global probe budget with the frozen defer bytes', async () => {
		canSend.mockResolvedValue({ allowed: true, state: 'half-open', generation: 0 });
		reserveProbe.mockResolvedValue(false);
		expect(await decide()).toBe(DECISION_DEFER_BYTES.global_probe);
	});

	it('answers an empty owned pool with the frozen defer bytes', async () => {
		selectIpWithLease.mockResolvedValue(null);
		expect(await decide()).toBe(DECISION_DEFER_BYTES.no_owned_ip);
	});

	it('answers a lease-write failure with the frozen defer bytes, classified local', async () => {
		const redis = {
			set: vi.fn().mockRejectedValue(new Error('redis down')),
			del: vi.fn().mockResolvedValue(1),
		} as unknown as Redis;
		const app = new Hono();
		app.use('/send/decision', async (c, next) => {
			c.set('auth', { isMasterKey: true });
			await next();
		});
		app.post('/send/decision', createRoutingDecisionHandler(redis, { ipPools: {} } as MtaConfig));
		const response = await app.request('/send/decision', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: REQUEST.messageId,
				workAttemptId: REQUEST.workAttemptId,
				routingReentryToken: REQUEST.routingReentryToken,
				startedAt: Date.now(),
				deliveryDomain: 'production',
				messageType: 'campaign',
				organizationId: REQUEST.organizationId,
				recipient: REQUEST.to,
				from: 'sender@mail.example.org',
				candidateProvider: 'mta',
				ipPool: 'campaign',
				allowWarmupOverflow: false,
			}),
		});
		// Our own storage failing, never a statement about this sending identity:
		// `lease_persistence` is the one reason the shared table calls `local`.
		expect(await response.text()).toBe(DECISION_DEFER_BYTES.lease_persistence);
	});
});

// ─── POST /send ────────────────────────────────────────────────────────────

function boundLease() {
	return JSON.stringify({
		token: REQUEST.routingLease,
		messageId: REQUEST.messageId,
		workAttemptId: REQUEST.workAttemptId,
		routingReentryToken: REQUEST.routingReentryToken,
		startedAt: REQUEST.routingReentry.retryState.startedAt,
		deliveryDomain: REQUEST.deliveryDomain,
		organizationId: REQUEST.organizationId,
		recipient: REQUEST.to,
		from: 'sender@mail.example.org',
		messageType: REQUEST.messageType,
		candidateProvider: 'mta',
		ipPool: REQUEST.ipPool,
		allowWarmupOverflow: REQUEST.allowWarmupOverflow,
		destinationProvider: 'gmail',
		probe: false,
		globalProbe: false,
		globalBreakerGeneration: 0,
		providerBreakerGeneration: 0,
		expiresAt: NOW + 60_000,
	});
}

async function intake(options: {
	body?: string;
	get?: (key: string) => string | null;
	set?: ReturnType<typeof vi.fn>;
	queueId?: string;
}) {
	const queue = {
		add: vi.fn().mockResolvedValue({ id: options.queueId ?? REQUEST.workAttemptId }),
		getJob: vi.fn().mockResolvedValue(null),
	};
	const redis = {
		zcard: vi.fn().mockResolvedValue(0),
		llen: vi.fn().mockResolvedValue(0),
		get: vi.fn(async (key: string) => options.get?.(key) ?? boundLease()),
		hgetall: vi.fn().mockResolvedValue({}),
		eval: vi.fn().mockResolvedValue(0),
		set: options.set ?? vi.fn().mockResolvedValue('OK'),
	} as unknown as Redis;
	const app = new Hono();
	app.use('/send', async (c, next) => {
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post('/send', createSendHandler(queue as unknown as Queue<EmailJob>, redis, 'governed'));
	const response = await app.request('/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: options.body ?? GOVERNED_SEND_REQUEST_BYTES,
	});
	return { response, queue };
}

describe('send intake', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	});

	it('accepts the frozen governed request bytes and answers with the frozen accepted bytes', async () => {
		const { response, queue } = await intake({});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(SEND_ACCEPTED_BYTES);
		expect(queue.add).toHaveBeenCalledOnce();
		// Every governed field the wire carries reaches the job, unchanged.
		const job = queue.add.mock.calls[0]![0]!.data as EmailJob;
		expect(job).toMatchObject({
			messageId: REQUEST.messageId,
			workAttemptId: REQUEST.workAttemptId,
			routingReentryToken: REQUEST.routingReentryToken,
			deliveryDomain: REQUEST.deliveryDomain,
			dkimDomain: 'mail.example.org',
			firstEnqueuedAt: REQUEST.routingReentry.retryState.startedAt,
		});
		expect(job.routingReentry).toEqual(REQUEST.routingReentry);
	});

	it('answers an already-accepted receipt with the frozen deduplicated bytes', async () => {
		const accepted = JSON.stringify({
			state: 'accepted',
			messageId: REQUEST.messageId,
			acceptedAt: NOW,
		});
		const { response, queue } = await intake({
			set: vi.fn().mockResolvedValue(null),
			get: (key) => (key.includes('lease') ? boundLease() : accepted),
		});
		expect(await response.text()).toBe(SEND_DEDUPLICATED_BYTES);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('answers a held reservation with the frozen intake-pending bytes', async () => {
		const reserved = JSON.stringify({
			state: 'reserved',
			messageId: REQUEST.messageId,
			reservedAt: NOW,
		});
		const { response, queue } = await intake({
			set: vi.fn().mockResolvedValue(null),
			get: (key) => (key.includes('lease') ? boundLease() : reserved),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toBe(SEND_INTAKE_PENDING_BYTES);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('answers a leaseless governed request with the frozen refusal bytes', async () => {
		const leaseless = JSON.parse(GOVERNED_SEND_REQUEST_BYTES) as Record<string, unknown>;
		delete leaseless['routingLease'];
		const { response, queue } = await intake({ body: JSON.stringify(leaseless) });
		expect(response.status).toBe(409);
		expect(await response.text()).toBe(SEND_LEASE_REQUIRED_BYTES);
		expect(queue.add).not.toHaveBeenCalled();
	});
});
