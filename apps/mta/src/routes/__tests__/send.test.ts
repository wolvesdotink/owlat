/**
 * Behaviour of the POST /send intake handler.
 *
 * `/send` is the *only* send-intake route (the duplicated `/send/batch`
 * route was removed — see send.ts). These cases lock the per-message
 * gates that the deleted batch path silently skipped — validation,
 * org-scoping, dedup, the health gate — plus the job that gets built and
 * how it is routed onto the queue. The postbox From-forgery gate has its
 * own focused suite in `sendFromBinding.test.ts`.
 *
 * We construct the Hono handler directly with minimal fakes, so every
 * branch is reachable without a live Redis/queue or a real server.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { AuthContext } from '../../server.js';
import { buildGroupKey, extractDomain } from '../../queue/groups.js';

vi.mock('../../redis.js', () => ({
	isRedisHealthy: vi.fn().mockResolvedValue(true),
	getRedis: vi.fn(),
}));
vi.mock('../../scaling/degradation.js', async () => {
	const actual = await vi.importActual('../../scaling/degradation.js');
	return {
		...actual,
		checkSystemHealth: vi
			.fn()
			.mockResolvedValue({ redisHealthy: true, backpressure: false, allIpsBlocked: false }),
	};
});
vi.mock('../routingDecision.js', () => ({
	readRoutingLease: vi.fn().mockResolvedValue({
		token: 'test-routing-lease',
		destinationProvider: 'other',
		probe: false,
		globalProbe: false,
		globalBreakerGeneration: 0,
		providerBreakerGeneration: 0,
		expiresAt: Date.now() + 60_000,
	}),
	isRoutingLeaseBoundTo: vi.fn().mockReturnValue(true),
}));

const { createSendHandler } = await import('../send.js');
const { checkSystemHealth } = await import('../../scaling/degradation.js');
const mockedHealth = vi.mocked(checkSystemHealth);

interface FakeQueue {
	add: ReturnType<typeof vi.fn>;
}

function fakeQueue(): FakeQueue {
	return { add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }) };
}

/** Minimal Redis double. `set` returns 'OK' (new id) unless overridden. */
function fakeRedis(overrides: Record<string, unknown> = {}): Redis {
	return {
		zcard: vi.fn().mockResolvedValue(0),
		set: vi.fn().mockResolvedValue('OK'),
		del: vi.fn().mockResolvedValue(1),
		eval: vi.fn().mockResolvedValue(1),
		llen: vi.fn().mockResolvedValue(0),
		hgetall: vi.fn().mockResolvedValue({}),
		get: vi.fn().mockResolvedValue(null),
		...overrides,
	} as unknown as Redis;
}

function buildApp(
	queue: FakeQueue,
	redis: Redis,
	auth: AuthContext = { isMasterKey: true },
	mode: 'governed' | 'postbox' | 'system' = 'governed'
): Hono {
	const app = new Hono();
	app.use('/send', async (c, next) => {
		c.set('auth', auth);
		await next();
	});
	app.post('/send', createSendHandler(queue as unknown as Queue<never>, redis, mode));
	return app;
}

/** A request body that passes every gate; override fields per case. */
function validBody(overrides: Record<string, unknown> = {}): string {
	const messageId = typeof overrides['messageId'] === 'string' ? overrides['messageId'] : 'msg-1';
	return JSON.stringify({
		messageId,
		to: 'bob@example.com',
		from: 'alice@example.com',
		subject: 'Hi',
		html: '<p>x</p>',
		ipPool: 'transactional',
		organizationId: 'crm-orgA',
		messageType: 'transactional',
		dkimDomain: 'example.com',
		routingLease: 'test-routing-lease',
		workAttemptId: 'work-attempt-1',
		routingReentryToken: 'reentry-token',
		allowWarmupOverflow: false,
		routingReentry: {
			envelopeInput: { kind: 'transactional' },
			retryState: { attempt: 1, startedAt: Date.now(), idempotencyKey: messageId },
		},
		...overrides,
	});
}

function post(app: Hono, body: string) {
	return app.request('/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});
}

describe('POST /send — health gate', () => {
	it('returns 503 when Redis is unhealthy and does not enqueue', async () => {
		mockedHealth.mockResolvedValueOnce({
			redisHealthy: false,
			backpressure: false,
			allIpsBlocked: false,
		});
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody());

		expect(res.status).toBe(503);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('returns 429 under backpressure and does not enqueue', async () => {
		mockedHealth.mockResolvedValueOnce({
			redisHealthy: true,
			backpressure: true,
			allIpsBlocked: false,
		});
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody());

		expect(res.status).toBe(429);
		expect(queue.add).not.toHaveBeenCalled();
	});
});

describe('POST /send — request validation', () => {
	it('returns 400 when a required field is missing', async () => {
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody({ subject: undefined }));

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('returns 400 on a malformed "to" address', async () => {
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody({ to: 'not-an-email' }));

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('returns 400 when dkimDomain is missing', async () => {
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody({ dkimDomain: undefined }));

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('returns 400 on an out-of-enum ipPool', async () => {
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody({ ipPool: 'bulk' }));

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('accepts a display-name "from" and queues it (Name <addr> form)', async () => {
		// Composers build From via formatFromAddress(defaultFromName), so the
		// real wire value is "Owlat <noreply@...>", not a bare address. Before
		// the angle-addr fix, isValidEmail(body.from) rejected this and /send
		// 400'd every display-name send.
		const queue = fakeQueue();
		const res = await post(
			buildApp(queue, fakeRedis()),
			validBody({ from: 'Owlat <noreply@mail.example.com>' })
		);

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);
		// The full display-name header is preserved on the job (the compose
		// path re-encodes the From header from this value downstream).
		const arg = queue.add.mock.calls[0]![0] as { data: Record<string, unknown> };
		expect(arg.data.from).toBe('Owlat <noreply@mail.example.com>');
	});

	it('returns 400 on a malformed angle-addr "from" (no usable address)', async () => {
		const queue = fakeQueue();
		const res = await post(
			buildApp(queue, fakeRedis()),
			validBody({ from: 'Owlat <not-an-email>' })
		);

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects a "from" whose display name carries CRLF header injection', async () => {
		// RFC 5322 §3.4 — a crafted display name must not be able to smuggle
		// an extra "Bcc:" header line into the message. The CR/LF guard
		// hard-stops it before parsing/queueing.
		const queue = fakeQueue();
		const res = await post(
			buildApp(queue, fakeRedis()),
			validBody({ from: 'Evil\r\nBcc: x <a@b.com>' })
		);

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects a bare "from" with a trailing CRLF-injected header line', async () => {
		const queue = fakeQueue();
		const res = await post(
			buildApp(queue, fakeRedis()),
			validBody({ from: 'noreply@mail.example.com\r\nBcc: evil@x.com' })
		);

		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});
});

describe('POST /send — per-org credential scoping', () => {
	it('returns 403 when a per-org credential targets a different organization', async () => {
		const queue = fakeQueue();
		const auth = {
			isMasterKey: false,
			orgCredential: { organizationId: 'orgA' },
		} as unknown as AuthContext;
		const res = await post(
			buildApp(queue, fakeRedis(), auth),
			validBody({ organizationId: 'orgB' })
		);

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not authorized/i);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('accepts when a per-org credential matches the target organization', async () => {
		const queue = fakeQueue();
		const auth = {
			isMasterKey: false,
			orgCredential: { organizationId: 'orgA' },
		} as unknown as AuthContext;
		const res = await post(
			buildApp(queue, fakeRedis(), auth),
			validBody({ organizationId: 'orgA' })
		);

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);
	});
});

describe('POST /send — dedup', () => {
	it('queues one real replacement for a fresh re-entry attempt with the same provider id', async () => {
		const seen = new Set<string>();
		const redis = fakeRedis({
			set: vi.fn(async (key: string) => {
				if (seen.has(key)) return null;
				seen.add(key);
				return 'OK';
			}),
		});
		const queue = fakeQueue();
		const app = buildApp(queue, redis);
		const first = await post(
			app,
			validBody({ messageId: 'send-stable', workAttemptId: 'attempt-1' })
		);
		const replacement = await post(
			app,
			validBody({ messageId: 'send-stable', workAttemptId: 'attempt-2' })
		);
		const duplicate = await post(
			app,
			validBody({ messageId: 'send-stable', workAttemptId: 'attempt-2' })
		);

		expect([first.status, replacement.status, duplicate.status]).toEqual([200, 200, 200]);
		expect(queue.add).toHaveBeenCalledTimes(2);
		expect(queue.add.mock.calls.map((call) => call[0].jobId)).toEqual(['attempt-1', 'attempt-2']);
		expect(await replacement.json()).toMatchObject({ success: true, id: 'send-stable' });
		expect(await duplicate.json()).toMatchObject({
			success: true,
			id: 'send-stable',
			deduplicated: true,
		});
	});

	it('returns a deduplicated response without enqueuing when messageId was already seen', async () => {
		const queue = fakeQueue();
		// SET NX miss → key already exists → duplicate.
		const redis = fakeRedis({ set: vi.fn().mockResolvedValue(null) });
		const res = await post(buildApp(queue, redis), validBody({ messageId: 'send_abc123' }));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; deduplicated?: boolean };
		// The dedup response MUST echo the submitted messageId (the VERP token),
		// NOT a literal "duplicate". The Convex worker stores this `id` as
		// providerMessageId and later bounce/complaint DSNs resolve on it via the
		// VERP Return-Path; a "duplicate" sentinel would make every post-acceptance
		// bounce resolve to send_not_found so the recipient is never suppressed.
		expect(body).toMatchObject({ success: true, id: 'send_abc123', deduplicated: true });
		expect(body.id).not.toBe('duplicate');
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('writes the work-attempt dedup key for the full four-day lifetime', async () => {
		const queue = fakeQueue();
		const redis = fakeRedis();
		await post(buildApp(queue, redis), validBody({ messageId: 'fresh-1' }));

		expect(redis.set).toHaveBeenCalledWith(
			'mta:work-attempts:work-attempt-1',
			'1',
			'PX',
			345_600_000,
			'NX'
		);
	});
});

describe('POST /send — job construction and routing', () => {
	it('builds the EmailJob and routes it by ipPool + recipient domain', async () => {
		const queue = fakeQueue();
		const res = await post(
			buildApp(queue, fakeRedis()),
			validBody({ to: 'bob@acme.com', ipPool: 'campaign', engagementScore: 90 })
		);

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);

		const arg = queue.add.mock.calls[0]![0] as {
			groupId: string;
			data: Record<string, unknown>;
			orderMs: number;
		};
		expect(arg.data).toMatchObject({
			messageId: 'msg-1',
			to: 'bob@acme.com',
			from: 'alice@example.com',
			subject: 'Hi',
			html: '<p>x</p>',
			ipPool: 'campaign',
			organizationId: 'crm-orgA',
			dkimDomain: 'example.com',
		});
		expect(arg.groupId).toBe(buildGroupKey('campaign', extractDomain('bob@acme.com')));
		expect(typeof arg.orderMs).toBe('number');
	});

	it('accepts an authorized Postbox PGP/MIME message without rewriting it', async () => {
		const queue = fakeQueue();
		const sealedMime = [
			'From: alice@example.com',
			'To: bob@example.com',
			'Subject: ...',
			'MIME-Version: 1.0',
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="sealed"',
			'',
			'--sealed--',
			'',
		].join('\r\n');
		const sealedMimeBase64 = Buffer.from(sealedMime).toString('base64');
		const res = await post(
			buildApp(queue, fakeRedis(), { isMasterKey: true }, 'postbox'),
			validBody({
				organizationId: 'postbox',
				messageType: undefined,
				subject: '...',
				sealedMimeBase64,
				allowedFromAddresses: ['alice@example.com'],
				routingLease: undefined,
				routingReentry: undefined,
				routingReentryToken: undefined,
				workAttemptId: undefined,
			})
		);

		expect(res.status).toBe(200);
		const arg = queue.add.mock.calls[0]![0] as { data: { sealedMimeBase64?: string } };
		expect(arg.data.sealedMimeBase64).toBe(sealedMimeBase64);
	});

	it('rejects sealed MIME whose From does not match the authorized envelope', async () => {
		const queue = fakeQueue();
		const forged = [
			'From: mallory@example.com',
			'Subject: ...',
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="x"',
			'',
			'--x--',
		].join('\r\n');
		const res = await post(
			buildApp(queue, fakeRedis(), { isMasterKey: true }, 'postbox'),
			validBody({
				organizationId: 'postbox',
				messageType: undefined,
				subject: '...',
				sealedMimeBase64: Buffer.from(forged).toString('base64'),
				allowedFromAddresses: ['alice@example.com'],
				routingLease: undefined,
				routingReentry: undefined,
			})
		);
		expect(res.status).toBe(400);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('copies anti-loop headers (vacation auto-reply) onto the enqueued job', async () => {
		// RFC 3834 §5: a vacation auto-reply MUST be stamped Auto-Submitted:
		// auto-replied (so a receiving auto-responder won't reply back) and
		// X-Auto-Response-Suppress: All (so Exchange/Outlook won't pile on). The
		// /send intake must carry these through to the job so the SMTP sender can
		// put them on the wire — dropping them here would silently un-loop-protect
		// every auto-reply.
		const queue = fakeQueue();
		const headers = {
			'Auto-Submitted': 'auto-replied',
			'X-Auto-Response-Suppress': 'All',
			Precedence: 'auto_reply',
		};
		const res = await post(buildApp(queue, fakeRedis()), validBody({ headers }));

		expect(res.status).toBe(200);
		const arg = queue.add.mock.calls[0]![0] as { data: { headers?: Record<string, string> } };
		expect(arg.data.headers).toEqual(headers);
	});

	it('leaves headers undefined on the job when the request omits them', async () => {
		const queue = fakeQueue();
		await post(buildApp(queue, fakeRedis()), validBody());
		const arg = queue.add.mock.calls[0]![0] as { data: { headers?: Record<string, string> } };
		expect(arg.data.headers).toBeUndefined();
	});

	it('returns the stable provider message id on success', async () => {
		const queue = fakeQueue();
		const res = await post(buildApp(queue, fakeRedis()), validBody());

		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; id: string };
		expect(body).toMatchObject({ success: true, id: 'msg-1' });
	});

	// ── async-DSN attribution regression (audit PR-01) ────────────────────────
	// Queue identity is per attempt, while provider/VERP identity is stable for
	// the Send. A fresh routing re-entry can therefore queue without duplicating
	// provider attribution.
	it('uses workAttemptId as jobId while returning the stable provider id', async () => {
		// A queue double that honours the supplied jobId, exactly like groupmq's
		// `AddOptions.jobId` does — the returned Job.id is the jobId we passed.
		const queue: FakeQueue = {
			add: vi
				.fn()
				.mockImplementation((opts: { jobId?: string }) =>
					Promise.resolve({ id: opts.jobId ?? 'random-uuid' })
				),
		};
		const res = await post(buildApp(queue, fakeRedis()), validBody({ messageId: 'send_abc123' }));

		expect(res.status).toBe(200);
		// queue.add uses the unique attempt identity.
		const arg = queue.add.mock.calls[0]![0] as { jobId?: string };
		expect(arg.jobId).toBe('work-attempt-1');
		// The response still echoes the stable provider/VERP identity.
		const body = (await res.json()) as { success: boolean; id: string };
		expect(body).toMatchObject({ success: true, id: 'send_abc123' });
	});

	it('returns 500 when the enqueue fails', async () => {
		const queue: FakeQueue = { add: vi.fn().mockRejectedValue(new Error('queue down')) };
		const res = await post(buildApp(queue, fakeRedis()), validBody());

		expect(res.status).toBe(500);
	});
});
