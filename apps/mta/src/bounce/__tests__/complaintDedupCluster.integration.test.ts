import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	completeComplaint,
	releaseComplaint,
	reserveComplaint,
	runComplaintEffect,
} from '../complaintDedupStore.js';

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

describe.runIf(dockerAvailable())('complaint deduplication on Redis Cluster', () => {
	const suffix = randomUUID().slice(0, 8);
	const basePort = 18_500 + Math.floor(Math.random() * 300) * 3;
	const ports = [basePort, basePort + 1, basePort + 2];
	const names = ports.map((_, index) => `owlat-fbl-${suffix}-${index}`);
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

	it('uses one cross-version-safe key for reservation, effects, release, and completion', async () => {
		const first = await reserveComplaint(cluster as never, 'cluster-complaint');
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		expect(await cluster.set(first.reservation.key, '1', 'EX', 60, 'NX')).toBeNull();
		const apply = vi.fn().mockResolvedValue(undefined);
		await runComplaintEffect(
			cluster as never,
			first.reservation,
			'0:circuit_breaker_outcome',
			apply
		);
		await releaseComplaint(cluster as never, first.reservation);

		const retry = await reserveComplaint(cluster as never, 'cluster-complaint');
		if (retry.kind !== 'reserved') throw new Error('expected retry reservation');
		await runComplaintEffect(
			cluster as never,
			retry.reservation,
			'0:circuit_breaker_outcome',
			apply
		);
		await completeComplaint(cluster as never, retry.reservation);

		expect(apply).toHaveBeenCalledOnce();
		expect(await cluster.hget(retry.reservation.key, 'status')).toBe('completed');
		expect(await cluster.ttl(retry.reservation.key)).toBeGreaterThan(7 * 86400 - 5);
		expect(await reserveComplaint(cluster as never, 'cluster-complaint')).toEqual({
			kind: 'completed',
		});
	}, 15_000);

	it('recognizes a legacy string key without changing its TTL', async () => {
		const key = 'mta:fbl:dedup:legacy-cluster-complaint';
		await cluster.set(key, '1', 'EX', 60);
		const before = await cluster.ttl(key);
		expect(await reserveComplaint(cluster as never, 'legacy-cluster-complaint')).toEqual({
			kind: 'completed',
		});
		expect(await cluster.get(key)).toBe('1');
		expect(await cluster.ttl(key)).toBeGreaterThanOrEqual(before - 1);
	}, 15_000);
});
