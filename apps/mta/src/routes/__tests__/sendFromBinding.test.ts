/**
 * From-binding enforcement on /send for Postbox traffic.
 *
 * We construct the Hono handler directly and exercise it with minimal
 * mocks. The route's other checks (queue health, dedup, etc.) are
 * already covered by integration tests upstream — this file is
 * exclusively about the postbox-from validation path.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';

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

const { createSendHandler } = await import('../send.js');

interface FakeQueue {
	add: ReturnType<typeof vi.fn>;
}

function fakeQueue(): FakeQueue {
	return {
		add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
	};
}

function fakeRedis() {
	return {
		// Health probe — return any number to mark healthy
		zcard: vi.fn().mockResolvedValue(0),
		// SETNX-style dedup write
		set: vi.fn().mockResolvedValue('OK'),
		// `checkSystemHealth` calls these or similar
		eval: vi.fn().mockResolvedValue(1),
		llen: vi.fn().mockResolvedValue(0),
		hgetall: vi.fn().mockResolvedValue({}),
		get: vi.fn().mockResolvedValue(null),
	} as unknown as Redis;
}

function buildApp(queue: FakeQueue, redis: Redis): Hono {
	const app = new Hono();
	app.use('/send', async (c, next) => {
		// Mock auth middleware sets master-key context
		c.set('auth', { isMasterKey: true });
		await next();
	});
	app.post('/send', createSendHandler(queue as unknown as Queue<never>, redis, 'postbox'));
	return app;
}

describe('POST /send — Postbox from-binding', () => {
	it('rejects 403 when from is not in allowedFromAddresses', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-1',
				to: 'bob@example.com',
				from: 'ceo@example.com',
				subject: 'Forged',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
				allowedFromAddresses: ['alice@example.com', 'alice+sales@example.com'],
			}),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not authorized/i);
		// Queue was not touched
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('accepts when from is in allowedFromAddresses', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-2',
				to: 'bob@example.com',
				from: 'alice@example.com',
				subject: 'Hi',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
				allowedFromAddresses: ['alice@example.com'],
			}),
		});

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);
	});

	it('matches alias case-insensitively', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-3',
				to: 'bob@example.com',
				from: 'Alice+Sales@Example.com',
				subject: 'Hi',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
				allowedFromAddresses: ['alice@example.com', 'alice+sales@example.com'],
			}),
		});

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);
	});

	it('binds a display-name "from" to its bare allowed address', async () => {
		// Postbox composers may send "Alice <alice@example.com>"; the gate must
		// match on the angle-addr so the display-name form is still authorized.
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-dn-1',
				to: 'bob@example.com',
				from: 'Alice <alice@example.com>',
				subject: 'Hi',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
				allowedFromAddresses: ['alice@example.com'],
			}),
		});

		expect(res.status).toBe(200);
		expect(queue.add).toHaveBeenCalledTimes(1);
	});

	it('rejects 403 when a display name wraps a forged address', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-dn-2',
				to: 'bob@example.com',
				from: 'Alice <ceo@example.com>',
				subject: 'Forged',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
				allowedFromAddresses: ['alice@example.com'],
			}),
		});

		expect(res.status).toBe(403);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects a non-Postbox organization on the fixed-scope intake', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-4',
				to: 'bob@example.com',
				from: 'random@somewhere.com',
				subject: 'Hi',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'crm-orgX',
				dkimDomain: 'somewhere.com',
				allowedFromAddresses: ['someone-else@somewhere.com'],
			}),
		});

		expect(res.status).toBe(403);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects when allowedFromAddresses is omitted', async () => {
		const queue = fakeQueue();
		const app = buildApp(queue, fakeRedis());

		const res = await app.request('/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'msg-5',
				to: 'bob@example.com',
				from: 'alice@example.com',
				subject: 'Hi',
				html: '<p>x</p>',
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: 'example.com',
			}),
		});

		expect(res.status).toBe(403);
		expect(queue.add).not.toHaveBeenCalled();
	});
});
