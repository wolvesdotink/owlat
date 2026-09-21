import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	dockerRedisAvailable,
	startRedisClusterFixture,
	stopRedisClusterFixture,
	type RedisClusterFixture,
} from '../../__tests__/helpers/redisCluster.js';
import {
	startRedisStandaloneFixture,
	stopRedisStandaloneFixture,
	type RedisStandaloneFixture,
} from '../../__tests__/helpers/redisStandalone.js';
import type { MtaConfig } from '../../config.js';
import {
	claimOne,
	getEntry,
	listEligibleIds,
	settleClaim,
	storeFailed,
	storePending,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_DUE_KEY,
	WEBHOOK_DLQ_ENTRIES_KEY,
	WEBHOOK_DLQ_PROTECTED_KEY,
} from '../dlq.js';

describe.runIf(dockerRedisAvailable())('webhook DLQ on standalone Redis', () => {
	const config = { webhookDlqMaxSize: 10 } as MtaConfig;
	let fixture: RedisStandaloneFixture;
	let redis: Redis;

	beforeAll(async () => {
		fixture = await startRedisStandaloneFixture('dlq');
		redis = fixture.client;
	}, 15_000);

	beforeEach(async () => {
		await redis.flushall();
	});

	afterAll(async () => {
		await stopRedisStandaloneFixture(fixture);
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

describe.runIf(dockerRedisAvailable())('webhook DLQ on Redis Cluster', () => {
	let fixture: RedisClusterFixture;
	let cluster: Redis.Cluster;

	beforeAll(async () => {
		fixture = await startRedisClusterFixture('dlq');
		cluster = fixture.client;
	}, 60_000);

	afterAll(() => {
		stopRedisClusterFixture(fixture);
	});

	it('executes store, claim, settle, eviction, and discard without CROSSSLOT', async () => {
		const config = { webhookDlqMaxSize: 2 } as MtaConfig;
		const event = { event: 'sent' as const, messageId: 'cluster-message', timestamp: Date.now() };
		const first = await storeFailed(cluster as never, event, { category: 'transport' }, config);
		const claimed = await claimOne(cluster as never, first, {
			owner: 'cluster-test',
			now: Date.now() + 60_001,
			requireDue: true,
			enforceAutoLimit: true,
			autoRetryLimit: 8,
		});
		expect(claimed).not.toBeNull();
		expect(await settleClaim(cluster as never, claimed!, 'failure', Date.now())).toBe(true);

		await storeFailed(cluster as never, event, { category: 'transport' }, config);
		const third = await storeFailed(cluster as never, event, { category: 'transport' }, config);
		expect(await getEntry(cluster as never, first)).toBeNull();
		expect(await getEntry(cluster as never, third)).not.toBeNull();
		const pending = await storePending(
			cluster as never,
			{ ...event, messageId: 'cluster-terminal' },
			config,
			'cluster-terminal:sent'
		);
		expect(await getEntry(cluster as never, pending)).not.toBeNull();
		expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, pending)).toBe(1);
		expect(await cluster.zcard(WEBHOOK_DLQ_CREATED_KEY)).toBe(config.webhookDlqMaxSize);
		await storeFailed(cluster as never, event, { category: 'transport' }, config);
		expect(await getEntry(cluster as never, pending)).not.toBeNull();
	}, 15_000);

	it('atomically frees every capacity artifact for missing and corrupt protected rows', async () => {
		for (const [id, raw] of [
			['cluster-corrupt', '{malformed'],
			['cluster-missing', null],
		] as const) {
			if (raw) await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, raw);
			await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`, '3');
			await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, `claim:${id}`, 'dead-owner|2');
			await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, `claim-expiry:${id}`, '1');
			await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, `version:${id}`, '2');
			await cluster.zadd(WEBHOOK_DLQ_CREATED_KEY, 1, id);
			await cluster.zadd(WEBHOOK_DLQ_DUE_KEY, 1, id);
			await cluster.sadd(WEBHOOK_DLQ_PROTECTED_KEY, id);
		}

		await listEligibleIds(cluster as never, { now: Date.now(), limit: 10, scanLimit: 10 });

		for (const id of ['cluster-corrupt', 'cluster-missing']) {
			expect(
				await cluster.hmget(
					WEBHOOK_DLQ_ENTRIES_KEY,
					id,
					`attempts:${id}`,
					`claim:${id}`,
					`claim-expiry:${id}`,
					`version:${id}`
				)
			).toEqual([null, null, null, null, null]);
			expect(await cluster.zscore(WEBHOOK_DLQ_CREATED_KEY, id)).toBeNull();
			expect(await cluster.zscore(WEBHOOK_DLQ_DUE_KEY, id)).toBeNull();
			expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, id)).toBe(0);
		}
	}, 15_000);

	it('atomically repairs a deterministic protected row and its indexes', async () => {
		const config = { webhookDlqMaxSize: 10 } as MtaConfig;
		const event = {
			event: 'complained' as const,
			messageId: 'cluster-repair',
			timestamp: Date.now(),
		};
		const id = await storePending(cluster as never, event, config, 'cluster-repair:complained');
		const raw = JSON.parse((await cluster.hget(WEBHOOK_DLQ_ENTRIES_KEY, id))!) as Record<
			string,
			unknown
		>;
		raw['attempts'] = 4;
		await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, JSON.stringify(raw));
		await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`, '99');
		await cluster.zrem(WEBHOOK_DLQ_CREATED_KEY, id);
		await cluster.zrem(WEBHOOK_DLQ_DUE_KEY, id);
		await cluster.srem(WEBHOOK_DLQ_PROTECTED_KEY, id);

		expect(await storePending(cluster as never, event, config, 'cluster-repair:complained')).toBe(
			id
		);
		expect(await getEntry(cluster as never, id)).toMatchObject({ dlqId: id, event });
		expect(await cluster.hget(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`)).toBe('4');
		expect(await cluster.zscore(WEBHOOK_DLQ_CREATED_KEY, id)).not.toBeNull();
		expect(await cluster.zscore(WEBHOOK_DLQ_DUE_KEY, id)).not.toBeNull();
		expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, id)).toBe(1);
	}, 15_000);

	it('atomically quarantines a protected row with an unknown event type', async () => {
		const config = { webhookDlqMaxSize: 10 } as MtaConfig;
		const event = {
			event: 'complained' as const,
			messageId: 'cluster-invalid-event',
			timestamp: Date.now(),
		};
		const key = 'cluster-invalid-event:complained';
		const id = await storePending(cluster as never, event, config, key);
		const raw = JSON.parse((await cluster.hget(WEBHOOK_DLQ_ENTRIES_KEY, id))!) as Record<
			string,
			unknown
		>;
		raw['event'] = { ...event, event: 'future.unrecognized' };
		await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, JSON.stringify(raw));

		await expect(storePending(cluster as never, event, config, key)).rejects.toThrow('quarantined');
		expect(await cluster.hmget(WEBHOOK_DLQ_ENTRIES_KEY, id, `attempts:${id}`)).toEqual([
			null,
			null,
		]);
		expect(await cluster.zscore(WEBHOOK_DLQ_CREATED_KEY, id)).toBeNull();
		expect(await cluster.zscore(WEBHOOK_DLQ_DUE_KEY, id)).toBeNull();
		expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, id)).toBe(0);
	}, 15_000);

	it('quarantines incomplete protected events and rejects immutable payload collisions', async () => {
		const config = { webhookDlqMaxSize: 10 } as MtaConfig;
		const event = {
			event: 'bounced' as const,
			messageId: 'cluster-payload-binding',
			bounceType: 'hard' as const,
			timestamp: Date.now(),
		};
		const key = 'cluster-payload-binding:bounced';
		const id = await storePending(cluster as never, event, config, key);

		await expect(
			storePending(cluster as never, { ...event, bounceType: 'soft' }, config, key)
		).rejects.toThrow('payload does not match');
		const raw = JSON.parse((await cluster.hget(WEBHOOK_DLQ_ENTRIES_KEY, id))!) as Record<
			string,
			unknown
		>;
		raw['event'] = { event: 'bounced', timestamp: event.timestamp };
		await cluster.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, JSON.stringify(raw));

		await expect(storePending(cluster as never, event, config, key)).rejects.toThrow('quarantined');
		expect(await getEntry(cluster as never, id)).toBeNull();
	}, 15_000);

	it('fails closed without deleting repaired protected rows at protected capacity', async () => {
		await cluster.del(
			WEBHOOK_DLQ_ENTRIES_KEY,
			WEBHOOK_DLQ_CREATED_KEY,
			WEBHOOK_DLQ_DUE_KEY,
			WEBHOOK_DLQ_PROTECTED_KEY
		);
		const one = { webhookDlqMaxSize: 1 } as MtaConfig;
		const hiddenEvent = {
			event: 'bounced' as const,
			messageId: 'cluster-hidden',
			bounceType: 'hard' as const,
			timestamp: Date.now(),
		};
		const hidden = await storePending(cluster as never, hiddenEvent, one, 'cluster-hidden:bounced');
		await cluster.zrem(WEBHOOK_DLQ_CREATED_KEY, hidden);
		await cluster.srem(WEBHOOK_DLQ_PROTECTED_KEY, hidden);
		const visible = await storePending(
			cluster as never,
			{ ...hiddenEvent, messageId: 'cluster-visible' },
			one,
			'cluster-visible:bounced'
		);

		await expect(
			storePending(cluster as never, hiddenEvent, one, 'cluster-hidden:bounced')
		).rejects.toThrow('could not retain this row at capacity');
		expect(await getEntry(cluster as never, hidden)).not.toBeNull();
		expect(await getEntry(cluster as never, visible)).not.toBeNull();
		expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, hidden)).toBe(1);
	}, 15_000);
});
