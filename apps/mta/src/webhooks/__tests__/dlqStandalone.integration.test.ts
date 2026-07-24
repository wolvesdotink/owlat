import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MtaConfig } from '../../config.js';
import {
	claimOne,
	getEntry,
	storePending,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_DUE_KEY,
	WEBHOOK_DLQ_ENTRIES_KEY,
	WEBHOOK_DLQ_PROTECTED_KEY,
} from '../dlq.js';

function dockerAvailable(): boolean {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 });
		execFileSync('docker', ['image', 'inspect', 'redis:7-alpine'], {
			stdio: 'ignore',
			timeout: 5_000,
		});
		return true;
	} catch {
		return false;
	}
}

describe.runIf(dockerAvailable())('webhook DLQ on standalone Redis', () => {
	const port = 18_000 + Math.floor(Math.random() * 1_000);
	const container = `owlat-dlq-standalone-${randomUUID().slice(0, 8)}`;
	const config = { webhookDlqMaxSize: 10 } as MtaConfig;
	let redis: Redis;

	beforeAll(async () => {
		execFileSync(
			'docker',
			[
				'run',
				'-d',
				'--rm',
				'--network',
				'host',
				'--name',
				container,
				'redis:7-alpine',
				'redis-server',
				'--port',
				String(port),
				'--appendonly',
				'no',
				'--protected-mode',
				'no',
			],
			{ stdio: 'ignore' }
		);
		redis = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 1 });
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				await redis.connect();
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		await redis.ping();
	}, 15_000);

	beforeEach(async () => {
		await redis.flushall();
	});

	afterAll(async () => {
		await redis?.quit();
		try {
			execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
		} catch {
			// Container may already have exited; --rm handled it.
		}
	});

	function event(messageId: string) {
		return {
			event: 'bounced' as const,
			messageId,
			bounceType: 'hard' as const,
			timestamp: Date.now(),
		};
	}

	it('structurally validates an existing row and repairs indexes and attempts atomically', async () => {
		const payload = event('standalone-repair');
		const id = await storePending(redis, payload, config, 'standalone-repair:bounced');
		const raw = JSON.parse((await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, id))!) as Record<
			string,
			unknown
		>;
		raw['attempts'] = 4;
		await redis.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, JSON.stringify(raw));
		await redis.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`, '99');
		await redis.zrem(WEBHOOK_DLQ_CREATED_KEY, id);
		await redis.zrem(WEBHOOK_DLQ_DUE_KEY, id);
		await redis.srem(WEBHOOK_DLQ_PROTECTED_KEY, id);

		expect(await storePending(redis, payload, config, 'standalone-repair:bounced')).toBe(id);
		expect(await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`)).toBe('4');
		expect(await redis.zscore(WEBHOOK_DLQ_CREATED_KEY, id)).not.toBeNull();
		expect(await redis.zscore(WEBHOOK_DLQ_DUE_KEY, id)).not.toBeNull();
		expect(await redis.sismember(WEBHOOK_DLQ_PROTECTED_KEY, id)).toBe(1);
	});

	it('preserves claim ownership when the same deterministic row is stored again', async () => {
		const payload = event('standalone-claim');
		const id = await storePending(redis, payload, config, 'standalone-claim:bounced');
		const claimed = await claimOne(redis, id, {
			owner: 'first-worker',
			now: Date.now(),
			requireDue: false,
			enforceAutoLimit: false,
			autoRetryLimit: 8,
		});
		expect(await storePending(redis, payload, config, 'standalone-claim:bounced')).toBe(id);
		expect(
			await claimOne(redis, id, {
				owner: 'second-worker',
				now: Date.now(),
				requireDue: false,
				enforceAutoLimit: false,
				autoRetryLimit: 8,
			})
		).toBeNull();
		expect(claimed).not.toBeNull();
	});

	it('quarantines an incomplete event-specific deterministic row', async () => {
		const payload = event('standalone-invalid');
		const id = await storePending(redis, payload, config, 'standalone-invalid:bounced');
		await redis.hset(
			WEBHOOK_DLQ_ENTRIES_KEY,
			id,
			JSON.stringify({
				dlqId: id,
				event: { event: 'bounced', timestamp: payload.timestamp },
				failure: { category: 'pending' },
				attempts: 9,
				createdAt: 'not-a-timestamp',
			})
		);

		await expect(
			storePending(redis, payload, config, 'standalone-invalid:bounced')
		).rejects.toThrow('quarantined');
		expect(await getEntry(redis, id)).toBeNull();
	});

	it('rejects deterministic identity reuse with a different immutable payload', async () => {
		const payload = event('standalone-payload-binding');
		const key = 'standalone-payload-binding:bounced';
		const id = await storePending(redis, payload, config, key);

		await expect(
			storePending(redis, { ...payload, bounceType: 'soft' }, config, key)
		).rejects.toThrow('payload does not match');
		expect(await getEntry(redis, id)).toMatchObject({ event: payload });
	});

	it('quarantines an unknown event type instead of repairing or protecting it', async () => {
		const payload = event('standalone-invalid-event');
		const key = 'standalone-invalid-event:bounced';
		const id = await storePending(redis, payload, config, key);
		const raw = JSON.parse((await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, id))!) as Record<
			string,
			unknown
		>;
		raw['event'] = { ...payload, event: 'future.unrecognized' };
		await redis.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, JSON.stringify(raw));

		expect(await getEntry(redis, id)).toBeNull();
		await expect(storePending(redis, payload, config, key)).rejects.toThrow('quarantined');
		expect(await redis.hmget(WEBHOOK_DLQ_ENTRIES_KEY, id, `attempts:${id}`)).toEqual([null, null]);
		expect(await redis.zscore(WEBHOOK_DLQ_CREATED_KEY, id)).toBeNull();
		expect(await redis.zscore(WEBHOOK_DLQ_DUE_KEY, id)).toBeNull();
		expect(await redis.sismember(WEBHOOK_DLQ_PROTECTED_KEY, id)).toBe(0);
	});

	it('fails closed instead of rewriting a structurally invalid claimed row', async () => {
		const payload = event('standalone-claimed-invalid');
		const id = await storePending(redis, payload, config, 'standalone-claimed-invalid:bounced');
		await redis.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, '{corrupt', `claim:${id}`, 'active-owner|1');

		await expect(
			storePending(redis, payload, config, 'standalone-claimed-invalid:bounced')
		).rejects.toThrow('inconsistent');
		expect(await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, id)).toBe('{corrupt');
		expect(await redis.hget(WEBHOOK_DLQ_ENTRIES_KEY, `claim:${id}`)).toBe('active-owner|1');
	});

	it('fails closed without deleting a repaired row at protected capacity', async () => {
		const one = { webhookDlqMaxSize: 1 } as MtaConfig;
		const hiddenEvent = event('standalone-hidden');
		const hidden = await storePending(redis, hiddenEvent, one, 'standalone-hidden:bounced');
		await redis.zrem(WEBHOOK_DLQ_CREATED_KEY, hidden);
		await redis.srem(WEBHOOK_DLQ_PROTECTED_KEY, hidden);
		const visible = await storePending(
			redis,
			event('standalone-visible'),
			one,
			'standalone-visible:bounced'
		);

		await expect(
			storePending(redis, hiddenEvent, one, 'standalone-hidden:bounced')
		).rejects.toThrow('could not retain this row at capacity');
		expect(await getEntry(redis, hidden)).not.toBeNull();
		expect(await getEntry(redis, visible)).not.toBeNull();
		expect(await redis.sismember(WEBHOOK_DLQ_PROTECTED_KEY, hidden)).toBe(1);
	});
});
