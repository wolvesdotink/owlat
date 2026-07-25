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

describe.runIf(dockerAvailable())('complaint deduplication on standalone Redis', () => {
	const suffix = randomUUID().slice(0, 8);
	const name = `owlat-fbl-standalone-${suffix}`;
	const port = 19_500 + Math.floor(Math.random() * 500);
	let redis: Redis;

	beforeAll(async () => {
		execFileSync(
			'docker',
			['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine'],
			{ stdio: 'ignore' }
		);
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				execFileSync('docker', ['exec', name, 'redis-cli', 'ping'], { stdio: 'ignore' });
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		redis = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: 3 });
		await redis.ping();
		await redis.flushall();
	}, 15_000);

	afterAll(async () => {
		await redis?.quit();
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
		} catch {
			// Container may already have exited; --rm handled it.
		}
	});

	it('recovers a legacy pre-effect crash into versioned owned state', async () => {
		const identity = `legacy-crash-${suffix}`;
		const legacyKey = `mta:fbl:dedup:${identity}`;
		await redis.set(legacyKey, '1', 'EX', 60);

		const reservation = await reserveComplaint(redis, identity);
		if (reservation.kind !== 'reserved') throw new Error('expected reservation');
		expect(await redis.hget(reservation.reservation.key, 'version')).toBe('2');
		expect(await redis.hget(reservation.reservation.key, 'status')).toBe('reserved');
		expect(await redis.get(legacyKey)).toBe('1');
	}, 10_000);

	it('retains one effect application across release and retry', async () => {
		const identity = `legacy-retry-${suffix}`;
		await redis.set(`mta:fbl:dedup:${identity}`, '1', 'EX', 60);
		const apply = vi.fn().mockResolvedValue(undefined);

		const first = await reserveComplaint(redis, identity);
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		await runComplaintEffect(redis, first.reservation, 'breaker-control', apply);
		await releaseComplaint(redis, first.reservation);

		const retry = await reserveComplaint(redis, identity);
		if (retry.kind !== 'reserved') throw new Error('expected retry reservation');
		await runComplaintEffect(redis, retry.reservation, 'breaker-control', apply);
		await completeComplaint(redis, retry.reservation);

		expect(apply).toHaveBeenCalledOnce();
		expect(await reserveComplaint(redis, identity)).toEqual({ kind: 'completed' });
	}, 10_000);
});
