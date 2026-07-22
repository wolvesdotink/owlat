import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.runIf(dockerAvailable())('webhook DLQ on Redis Cluster', () => {
	const suffix = randomUUID().slice(0, 8);
	const basePort = 17_000 + Math.floor(Math.random() * 500) * 3;
	const ports = [basePort, basePort + 1, basePort + 2];
	const names = ports.map((_, index) => `owlat-dlq-${suffix}-${index}`);
	let cluster: Redis.Cluster;

	beforeAll(async () => {
		for (let index = 0; index < ports.length; index++) {
			execFileSync(
				'docker',
				[
					'run',
					'-d',
					'--rm',
					'--network',
					'host',
					'--name',
					names[index]!,
					'redis:7-alpine',
					'redis-server',
					'--port',
					String(ports[index]),
					'--cluster-enabled',
					'yes',
					'--cluster-config-file',
					'nodes.conf',
					'--cluster-node-timeout',
					'5000',
					'--appendonly',
					'no',
					'--protected-mode',
					'no',
				],
				{ stdio: 'ignore' }
			);
		}
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				execFileSync('docker', ['exec', names[0]!, 'redis-cli', '-p', String(ports[0]), 'ping'], {
					stdio: 'ignore',
				});
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		execFileSync(
			'docker',
			[
				'run',
				'--rm',
				'--network',
				'host',
				'redis:7-alpine',
				'redis-cli',
				'--cluster',
				'create',
				...ports.map((port) => `127.0.0.1:${port}`),
				'--cluster-replicas',
				'0',
				'--cluster-yes',
			],
			{ stdio: 'ignore', timeout: 15_000 }
		);
		cluster = new Redis.Cluster(ports.map((port) => ({ host: '127.0.0.1', port })));
		await cluster.flushall();
	}, 30_000);

	afterAll(async () => {
		await cluster?.quit();
		for (const name of names) {
			try {
				execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
			} catch {
				// Container may already have exited; --rm handled it.
			}
		}
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
		).rejects.toThrow('protected capacity');
		expect(await getEntry(cluster as never, hidden)).not.toBeNull();
		expect(await getEntry(cluster as never, visible)).not.toBeNull();
		expect(await cluster.sismember(WEBHOOK_DLQ_PROTECTED_KEY, hidden)).toBe(1);
	}, 15_000);
});
