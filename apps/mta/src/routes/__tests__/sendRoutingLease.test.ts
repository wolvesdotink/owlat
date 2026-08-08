import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { Queue } from 'groupmq';
import type { EmailJob } from '../../types.js';

vi.mock('../../scaling/degradation.js', () => ({
	checkSystemHealth: vi
		.fn()
		.mockResolvedValue({ redisHealthy: true, backpressure: false, allIpsBlocked: false }),
}));

const { createSendHandler } = await import('../send.js');
const STARTED_AT = Date.now();

function body(overrides: Record<string, unknown> = {}) {
	return {
		messageId: 'message-1',
		to: 'user@example.com',
		from: 'sender@example.org',
		subject: 'Subject',
		html: '<p>Body</p>',
		ipPool: 'campaign',
		organizationId: 'org-1',
		messageType: 'campaign',
		deliveryDomain: 'production',
		dkimDomain: 'example.org',
		routingLease: 'token-1',
		workAttemptId: 'work-attempt-1',
		routingReentryToken: 'reentry-token',
		allowWarmupOverflow: false,
		routingReentry: {
			envelopeInput: { kind: 'campaign' },
			retryState: { attempt: 1, startedAt: STARTED_AT, idempotencyKey: 'message-1' },
		},
		...overrides,
	};
}

function lease(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		token: 'token-1',
		messageId: 'message-1',
		workAttemptId: 'work-attempt-1',
		routingReentryToken: 'reentry-token',
		organizationId: 'org-1',
		recipient: 'user@example.com',
		from: 'sender@example.org',
		messageType: 'campaign',
		startedAt: STARTED_AT,
		deliveryDomain: 'production',
		candidateProvider: 'mta',
		ipPool: 'campaign',
		destinationProvider: 'gmail',
		probe: false,
		globalProbe: false,
		globalBreakerGeneration: 0,
		providerBreakerGeneration: 0,
		expiresAt: Date.now() + 60_000,
		ip: '10.0.0.1',
		eligibilityGeneration: 7,
		...overrides,
	});
}

async function request(options: {
	/** Omit for the bound lease; `null` is the key Redis no longer has. */
	lease?: string | null;
	evalResult?: number;
	state?: (key: string) => object;
	bodyOverrides?: Record<string, unknown>;
	mode?: 'governed' | 'postbox' | 'system';
	auth?: {
		isMasterKey: boolean;
		orgCredential?: { organizationId: string };
	};
}) {
	const queue = { add: vi.fn().mockResolvedValue({ id: 'message-1' }) };
	const redis = {
		zcard: vi.fn().mockResolvedValue(0),
		llen: vi.fn().mockResolvedValue(0),
		get: vi.fn().mockResolvedValue('lease' in options ? options.lease : lease()),
		hgetall: vi.fn(async (key: string) => options.state?.(key) ?? {}),
		eval: vi.fn().mockResolvedValue(options.evalResult ?? 1),
		set: vi.fn().mockResolvedValue('OK'),
	} as unknown as Redis;
	const app = new Hono();
	app.use('/send', async (c, next) => {
		c.set('auth', options.auth ?? { isMasterKey: true });
		await next();
	});
	app.post('/send', createSendHandler(queue as unknown as Queue<EmailJob>, redis, options.mode));
	const response = await app.request('/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(
			body({
				...(options.mode && options.mode !== 'governed'
					? {
							routingReentry: undefined,
							routingReentryToken: undefined,
							workAttemptId: undefined,
						}
					: {}),
				...options.bodyOverrides,
			})
		),
	});
	return { response, queue };
}

describe('POST /send routing lease revalidation', () => {
	it('rejects a governed send without a routing lease', async () => {
		const { response, queue } = await request({ bodyOverrides: { routingLease: undefined } });
		expect(response.status).toBe(409);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('keeps Postbox on its master-only fixed scope without a tenant lease', async () => {
		const { response, queue } = await request({
			mode: 'postbox',
			bodyOverrides: {
				organizationId: 'postbox',
				messageType: undefined,
				routingLease: undefined,
				allowedFromAddresses: ['sender@example.org'],
			},
		});
		expect(response.status).toBe(200);
		expect(queue.add).toHaveBeenCalledOnce();
	});

	it.each([
		{
			label: 'Postbox',
			mode: 'postbox' as const,
			organizationId: 'postbox',
			extra: { allowedFromAddresses: ['sender@example.org'] },
		},
		{ label: 'system', mode: 'system' as const, organizationId: 'system', extra: {} },
	])('keeps $label intake master-only and fixed to its route scope', async (scope) => {
		const unprivileged = await request({
			mode: scope.mode,
			auth: { isMasterKey: false, orgCredential: { organizationId: scope.organizationId } },
			bodyOverrides: {
				organizationId: scope.organizationId,
				messageType: undefined,
				routingLease: undefined,
				...scope.extra,
			},
		});
		expect(unprivileged.response.status).toBe(403);
		expect(unprivileged.queue.add).not.toHaveBeenCalled();

		const wrongScope = await request({
			mode: scope.mode,
			bodyOverrides: {
				organizationId: 'org-1',
				messageType: undefined,
				routingLease: undefined,
				...scope.extra,
			},
		});
		expect(wrongScope.response.status).toBe(403);
		expect(wrongScope.queue.add).not.toHaveBeenCalled();
	});

	it('refuses Postbox traffic on the governed intake', async () => {
		const { response, queue } = await request({
			bodyOverrides: {
				organizationId: 'postbox',
				messageType: undefined,
				routingLease: undefined,
				allowedFromAddresses: ['sender@example.org'],
			},
		});
		expect(response.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});
	it.each([
		lease({ organizationId: 'org-2' }),
		lease({ recipient: 'other@example.com' }),
		lease({ messageId: 'message-2' }),
	])('rejects a replay outside the bound tenant/message/recipient', async (storedLease) => {
		const { response, queue } = await request({ lease: storedLease });
		expect(response.status).toBe(409);
		// GOVERNANCE, NOT A STORAGE FAULT: the record is right there and readable,
		// it just does not bind this send. Convex counts this against gate 2.
		expect(await response.json()).toMatchObject({ code: 'ROUTING_DECISION_EXPIRED' });
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects an IP generation change between decision and enqueue', async () => {
		const { response, queue } = await request({ evalResult: 0 });
		expect(response.status).toBe(409);
		expect(queue.add).not.toHaveBeenCalled();
	});

	// ISSUE #505. Every one of these defers the send; what differs is the CODE, and
	// the code is the only thing that tells Convex whether the deferral is evidence
	// about this sending identity (gate 2's `governed` budget, 10% ceiling and a
	// 25% halt) or about our own lease store (`local`, not counted). One over-broad
	// `ROUTING_DECISION_EXPIRED` used to answer all of them, so a Redis that lost a
	// lease record could walk a cell towards a halt over a fault no receiver saw.
	describe('separates an unreadable lease from an expired one', () => {
		it.each([
			{ label: 'a truncated value', stored: '{"token":"token-1","messageId":"mess' },
			{ label: 'a value that is not an object', stored: '"token-1"' },
			{ label: 'a record naming another token', stored: lease({ token: 'token-2' }) },
			{ label: 'a record with no usable deadline', stored: lease({ expiresAt: 'soon' }) },
		])('answers the local code for $label', async ({ stored }) => {
			const { response, queue } = await request({ lease: stored });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: 'ROUTING_LEASE_UNREADABLE' });
			expect(queue.add).not.toHaveBeenCalled();
		});

		it('does not answer the local code for a lease that aged out', async () => {
			const { response, queue } = await request({ lease: lease({ expiresAt: Date.now() - 1 }) });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: 'ROUTING_DECISION_EXPIRED' });
			expect(queue.add).not.toHaveBeenCalled();
		});

		// THE HONEST RESIDUE. The key is written with a 15-minute `EX` and an
		// `expiresAt` the same distance ahead, so a missing key is a lease that aged
		// out in the ordinary case — and a `GET` returning nil looks identical
		// whether the TTL elapsed or an eviction took it. The MTA keeps calling that
		// governance rather than guessing; only a record it can SEE and cannot USE is
		// reported as our own storage failing.
		it('keeps the governed code for a key Redis no longer has', async () => {
			const { response, queue } = await request({ lease: null });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: 'ROUTING_DECISION_EXPIRED' });
			expect(queue.add).not.toHaveBeenCalled();
		});
	});

	it('rejects a global or provider breaker race before enqueue', async () => {
		const open = { status: 'open', cooldownUntil: String(Date.now() + 60_000) };
		const global = await request({ state: (key) => (key.includes(':provider:') ? {} : open) });
		expect(global.response.status).toBe(409);
		expect(global.queue.add).not.toHaveBeenCalled();

		const provider = await request({ state: (key) => (key.includes(':provider:') ? open : {}) });
		expect(provider.response.status).toBe(409);
		expect(provider.queue.add).not.toHaveBeenCalled();
	});
});
