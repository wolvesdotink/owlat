/**
 * Postbox mail runs on its own lane (plan 2.13).
 *
 * GroupMQ runs one job at a time per group, and the shared group for a domain
 * is `transactional:<domain>`. Before the lane, a person's reply to a gmail.com
 * address queued behind every system/API message already waiting for
 * gmail.com. These run the real GroupMQ Lua, so they pin the queue behaviour
 * the lane relies on, not a model of it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Queue } from 'groupmq';
import { withLuaScripting } from '../../__tests__/helpers/luaScriptedRedisMock.js';
import { buildGroupKey } from '../groups.js';

interface Payload {
	kind: 'system' | 'postbox';
}

describe('postbox queue lane', () => {
	let queue: Queue<Payload>;

	beforeEach(async () => {
		const redis = new RedisMock();
		await redis.flushall();
		withLuaScripting(redis);
		queue = new Queue<Payload>({
			redis: redis as never,
			namespace: 'postbox-lane',
			jobTimeoutMs: 120_000,
			maxAttempts: 5,
		});
	});

	async function enqueue(jobId: string, groupId: string, kind: Payload['kind']) {
		await queue.add({ groupId, data: { kind }, jobId });
	}

	it('keeps shared transactional mail to one domain strictly one at a time', async () => {
		const shared = buildGroupKey('transactional', 'gmail.com');
		await enqueue('sys-1', shared, 'system');
		await enqueue('sys-2', shared, 'system');

		expect((await queue.reserve())?.id).toBe('sys-1');
		// sys-1 is still in flight, so its group is gated.
		expect(await queue.reserve()).toBeNull();
	});

	it('lets a Postbox reply start while a system burst to the same domain is in flight', async () => {
		const shared = buildGroupKey('transactional', 'gmail.com');
		for (let i = 1; i <= 3; i++) await enqueue(`sys-${i}`, shared, 'system');
		await enqueue('pb-1', buildGroupKey('transactional', 'gmail.com', 'postbox'), 'postbox');

		expect((await queue.reserve())?.id).toBe('sys-1');
		// Without the lane the reply would sit behind sys-2 and sys-3.
		const next = await queue.reserve();
		expect(next?.id).toBe('pb-1');
		expect(next?.groupId).toBe('postbox:transactional:gmail.com');
	});

	it('still runs Postbox mail to one domain one at a time', async () => {
		const lane = buildGroupKey('transactional', 'gmail.com', 'postbox');
		await enqueue('pb-1', lane, 'postbox');
		await enqueue('pb-2', lane, 'postbox');

		expect((await queue.reserve())?.id).toBe('pb-1');
		expect(await queue.reserve()).toBeNull();
	});
});
