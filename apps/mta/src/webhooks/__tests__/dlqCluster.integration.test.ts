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
});
