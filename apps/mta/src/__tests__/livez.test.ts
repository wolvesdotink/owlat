import { describe, expect, it } from 'vitest';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import { createApp } from '../server.js';
import type { EmailJob } from '../types.js';
import { createTestConfig } from './helpers/fixtures.js';

/**
 * A stand-in that records every property read. Route factories may keep a
 * reference while the app is built; what matters is that answering /livez
 * reads nothing from Redis or the queue.
 */
function recording<T extends object>(): { value: T; reads: string[] } {
	const reads: string[] = [];
	const value = new Proxy(
		{},
		{
			get(_target, property) {
				reads.push(String(property));
				return () => {
					throw new Error(`unexpected call to ${String(property)}`);
				};
			},
		}
	) as T;
	return { value, reads };
}

describe('GET /livez', () => {
	it('answers without a token and without touching Redis or the queue', async () => {
		const redis = recording<Redis>();
		const queue = recording<Queue<EmailJob>>();
		const app = createApp(queue.value, redis.value, createTestConfig());
		redis.reads.length = 0;
		queue.reads.length = 0;

		const res = await app.request('/livez');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
		expect(redis.reads).toEqual([]);
		expect(queue.reads).toEqual([]);
	});

	it('leaves the authenticated routes behind their token', async () => {
		const app = createApp(
			recording<Queue<EmailJob>>().value,
			recording<Redis>().value,
			createTestConfig()
		);

		expect((await app.request('/send', { method: 'POST' })).status).toBe(401);
	});
});
