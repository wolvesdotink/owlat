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
	POSTBOX_SEALED_SEND_REQUEST_BYTES,
	POSTBOX_SEND_REQUEST_BYTES,
	SEALED_MIME_BASE64,
	SEND_ACCEPTED_BYTES,
	SEND_DEDUPLICATED_BYTES,
	SEND_INTAKE_PENDING_BYTES,
	SEND_LEASE_REQUIRED_BYTES,
	SYSTEM_SEND_REQUEST_BYTES,
	IP_REPUTATION_SNAPSHOT_BYTES,
	WIRE_FIXTURE_NOW,
} from '@owlat/mta-protocol/wireFixtures';
import { normalizeIpReputationPayload } from '@owlat/mta-protocol/ipReputation';

const canSend = vi.hoisted(() => vi.fn());
const canSendScope = vi.hoisted(() => vi.fn());
const relayAllowed = vi.hoisted(() => vi.fn());
const reserveProbe = vi.hoisted(() => vi.fn());
const reserveWarmingSlot = vi.hoisted(() => vi.fn());
const selectIpWithLease = vi.hoisted(() => vi.fn());
const getWarmingState = vi.hoisted(() => vi.fn());
const getPoolStatus = vi.hoisted(() => vi.fn());
const getIpMetrics = vi.hoisted(() => vi.fn());
const getIspMetrics = vi.hoisted(() => vi.fn());

vi.mock('../../intelligence/circuitBreaker.js', () => ({
	canSend,
	canSendScope,
	isRelayAllowedByGlobalBreaker: relayAllowed,
	reserveHalfOpenProbe: reserveProbe,
	releaseHalfOpenProbe: vi.fn().mockResolvedValue(undefined),
	getState: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../intelligence/warming.js', () => ({
	reserveWarmingSlot,
	releaseWarmingSlot: vi.fn().mockResolvedValue(undefined),
	getWarmingState,
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
	getPoolStatus,
}));
vi.mock('../../monitoring/collector.js', () => ({ getIpMetrics, getIspMetrics }));
vi.mock('../../scaling/fcrdns.js', () => ({
	getFcrdnsReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../scaling/ipv6SpfReadiness.js', () => ({
	getIpv6SpfReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../scaling/sourceAddressReadiness.js', () => ({
	getSourceAddressReadiness: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../intelligence/dnsbl.js', () => ({
	configuredDnsblZones: vi.fn().mockReturnValue([{ id: 'spamhaus-zen' }]),
	getDnsblStatus: vi
		.fn()
		.mockResolvedValue({ overallStatus: 'clean', 'spamhaus-zenAt': String(WIRE_FIXTURE_NOW) }),
	hasUnmeasuredDnsblZone: vi.fn().mockReturnValue(false),
}));
// The snapshot route is master-key-only; WHO may read it is not what this suite
// pins, so the gate is stubbed open and the bytes are the subject.
vi.mock('../../auth/masterKeyAuth.js', () => ({
	masterKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));
vi.mock('../../scaling/degradation.js', () => ({
	checkSystemHealth: vi
		.fn()
		.mockResolvedValue({ redisHealthy: true, backpressure: false, allIpsBlocked: false }),
}));

const { createRoutingDecisionHandler } = await import('../routingDecision.js');
const { createSendHandler } = await import('../send.js');
const { createIpReputationRoutes } = await import('../ipReputation.js');

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
	getWarmingState.mockResolvedValue({ phase: 'ramp', currentDay: 5 });
	getPoolStatus.mockResolvedValue([
		{ ip: '192.0.2.10', pool: 'campaign', active: true, blockReasons: [] },
	]);
	getIpMetrics.mockResolvedValue({ sent: 400, delivered: 390, bounced: 4, deferred: 6 });
	getIspMetrics.mockResolvedValue({});
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

// ─── POST /send/postbox ────────────────────────────────────────────────────

/**
 * Drive the SHIPPED postbox intake with the frozen Postbox bodies.
 *
 * The three fields only this leg carries — `sealedMimeBase64`, `amp`,
 * `allowedFromAddresses` — had no typed producer before D7 bound
 * `mail/outbound.ts` and `mail/deliveryHooks.ts` to `MtaSendRequest`, and they
 * fail QUIETLY: a dropped `sealedMimeBase64` ships the placeholder `html: ' '`
 * body and loses the ciphertext, a dropped `amp` loses the alternative part,
 * and a dropped `allowedFromAddresses` refuses every personal-mailbox send.
 */
async function postboxIntake(body: string) {
	const queue = {
		add: vi.fn().mockResolvedValue({ id: 'pb-queue-1' }),
		getJob: vi.fn().mockResolvedValue(null),
	};
	const redis = {
		zcard: vi.fn().mockResolvedValue(0),
		llen: vi.fn().mockResolvedValue(0),
		get: vi.fn().mockResolvedValue(null),
		hgetall: vi.fn().mockResolvedValue({}),
		eval: vi.fn().mockResolvedValue(0),
		set: vi.fn().mockResolvedValue('OK'),
	} as unknown as Redis;
	const app = new Hono();
	app.use('/send/postbox', async (c, next) => {
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post(
		'/send/postbox',
		createSendHandler(queue as unknown as Queue<EmailJob>, redis, 'postbox')
	);
	const response = await app.request('/send/postbox', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});
	return { response, queue };
}

describe('postbox send intake', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	});

	it('accepts the frozen unsealed postbox bytes and carries amp onto the job', async () => {
		const { response, queue } = await postboxIntake(POSTBOX_SEND_REQUEST_BYTES);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			JSON.stringify({ success: true, id: 'pb-fixture-1', workAttemptId: 'pb-queue-1' })
		);
		const job = queue.add.mock.calls[0]![0]!.data as EmailJob;
		expect(job).toMatchObject({
			messageId: 'pb-fixture-1',
			to: 'recipient@example.com',
			subject: 'Postbox wire fixture',
			text: 'hi',
			amp: '<html amp4email><body>hi</body></html>',
			ipPool: 'transactional',
			organizationId: 'postbox',
			dkimDomain: 'mail.example.org',
		});
	});

	it('accepts the frozen sealed postbox bytes and carries the ciphertext unchanged', async () => {
		const { response, queue } = await postboxIntake(POSTBOX_SEALED_SEND_REQUEST_BYTES);
		expect(response.status).toBe(200);
		const job = queue.add.mock.calls[0]![0]!.data as EmailJob;
		// Byte-for-byte: the MTA passes the PGP/MIME envelope through, and the
		// structured half stays the placeholder the producer sent.
		expect(job.sealedMimeBase64).toBe(SEALED_MIME_BASE64);
		expect(job.subject).toBe('...');
		expect(job.html).toBe(' ');
	});

	it('refuses a From outside the allowed set the producer computed', async () => {
		const forged = JSON.parse(POSTBOX_SEND_REQUEST_BYTES) as Record<string, unknown>;
		forged['from'] = 'Owlat <someone-else@mail.example.org>';
		const { response, queue } = await postboxIntake(JSON.stringify(forged));
		expect(response.status).toBe(403);
		expect(await response.text()).toBe(
			JSON.stringify({ error: 'From address not authorized for this mailbox' })
		);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('refuses a body whose allowed-from set never arrived', async () => {
		// The shape of the silent outage a renamed `allowedFromAddresses` would
		// cause on every postbox producer at once: the field simply is not there.
		const stripped = JSON.parse(POSTBOX_SEND_REQUEST_BYTES) as Record<string, unknown>;
		delete stripped['allowedFromAddresses'];
		const { response, queue } = await postboxIntake(JSON.stringify(stripped));
		expect(response.status).toBe(403);
		expect(queue.add).not.toHaveBeenCalled();
	});
});

// ─── POST /send/system ─────────────────────────────────────────────────────

/**
 * Drive the SHIPPED system intake with the frozen auth-mail body.
 *
 * This leg carries the FEWEST fields of the three — no routing material at all,
 * which is exactly what its mode gate refuses (`!auth.isMasterKey ||
 * organizationId !== 'system'`, then the lease/re-entry refusal). Pinned on the
 * producer side alone the fixture proves nothing about this gate: tighten the
 * required-field check here and every auth invite, password reset and
 * double-opt-in mail would be refused at the intake with both suites still
 * green. So the bytes go through the handler.
 */
async function systemIntake(body: string) {
	const queue = {
		add: vi.fn().mockResolvedValue({ id: 'sys-queue-1' }),
		getJob: vi.fn().mockResolvedValue(null),
	};
	const redis = {
		zcard: vi.fn().mockResolvedValue(0),
		llen: vi.fn().mockResolvedValue(0),
		get: vi.fn().mockResolvedValue(null),
		hgetall: vi.fn().mockResolvedValue({}),
		eval: vi.fn().mockResolvedValue(0),
		set: vi.fn().mockResolvedValue('OK'),
	} as unknown as Redis;
	const app = new Hono();
	app.use('/send/system', async (c, next) => {
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post('/send/system', createSendHandler(queue as unknown as Queue<EmailJob>, redis, 'system'));
	const response = await app.request('/send/system', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});
	return { response, queue };
}

describe('system send intake', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	});

	it('accepts the frozen system request bytes and answers with the accepted bytes', async () => {
		const { response, queue } = await systemIntake(SYSTEM_SEND_REQUEST_BYTES);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			JSON.stringify({ success: true, id: 'system-fixture-1', workAttemptId: 'sys-queue-1' })
		);
		const job = queue.add.mock.calls[0]![0]!.data as EmailJob;
		expect(job).toMatchObject({
			messageId: 'system-fixture-1',
			to: 'person@example.com',
			subject: 'Reset your password',
			html: '<p>reset</p>',
			ipPool: 'transactional',
			organizationId: 'system',
			dkimDomain: 'mail.example.org',
		});
		// System mail is ungoverned by construction: no lease, no re-entry, no
		// delivery domain. Its dedupe identity is the caller's messageId, which is
		// what `buildSystemMailExtras` carries the idempotency key as.
		expect(job.routingLease).toBeUndefined();
		expect(job.routingReentry).toBeUndefined();
		expect(job.deliveryDomain).toBeUndefined();
		expect(job.intakeReceiptId).toBe('system-fixture-1');
	});

	it('refuses the frozen body presented under a per-org credential', async () => {
		const queue = {
			add: vi.fn().mockResolvedValue({ id: 'sys-queue-1' }),
			getJob: vi.fn().mockResolvedValue(null),
		};
		const redis = {
			zcard: vi.fn().mockResolvedValue(0),
			llen: vi.fn().mockResolvedValue(0),
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
		} as unknown as Redis;
		const app = new Hono();
		app.use('/send/system', async (c, next) => {
			c.set('auth', { isMasterKey: false, orgCredential: { organizationId: 'system' } });
			await next();
		});
		app.post(
			'/send/system',
			createSendHandler(queue as unknown as Queue<EmailJob>, redis, 'system')
		);
		const response = await app.request('/send/system', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: SYSTEM_SEND_REQUEST_BYTES,
		});
		expect(response.status).toBe(403);
		expect(queue.add).not.toHaveBeenCalled();
	});
});

// ─── GET /ip-reputation ────────────────────────────────────────────────────

describe('ip-reputation snapshot', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: WIRE_FIXTURE_NOW, toFake: ['Date'] });
	});

	it('serves the frozen snapshot bytes the warming sync normalizes', async () => {
		// The one leg of this wire whose producer is NOT bound to the contract at
		// compile time: `createIpReputationRoutes` is deliberately wider than
		// `MtaIpReputationPayload` and weaker in two places, so nothing stops it
		// renaming a field the normalizer requires. Rename `warmingPhase` and
		// `normalizeIpReputationPayload` returns null for every real snapshot —
		// `delivery/warmingSync.ts` stops caching MTA warming state and the plane
		// goes stale with no error anywhere. This byte comparison is what catches
		// it, so it drives the SHIPPED route rather than a rebuilt summary.
		const redis = {} as unknown as Redis;
		const config = {
			ipPools: { transactional: [], campaign: ['192.0.2.10'] },
		} as unknown as MtaConfig;
		const app = new Hono();
		app.route('/ip-reputation', createIpReputationRoutes(redis, config));

		const response = await app.request('/ip-reputation');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(IP_REPUTATION_SNAPSHOT_BYTES);
	});

	it('serves a snapshot the consumer’s normalizer accepts', async () => {
		const redis = {} as unknown as Redis;
		const config = {
			ipPools: { transactional: [], campaign: ['192.0.2.10'] },
		} as unknown as MtaConfig;
		const app = new Hono();
		app.route('/ip-reputation', createIpReputationRoutes(redis, config));

		const payload: unknown = await (await app.request('/ip-reputation')).json();
		// The other half of the same statement: the bytes above are not merely
		// stable, they are bytes the far end can still read.
		expect(normalizeIpReputationPayload(payload)).not.toBeNull();
	});
});
