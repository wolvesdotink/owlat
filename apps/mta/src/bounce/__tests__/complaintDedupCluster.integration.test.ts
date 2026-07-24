import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	completeComplaint,
	releaseComplaint,
	reserveComplaint,
	runComplaintEffect,
	type ComplaintDedupReservation,
} from '../complaintDedupStore.js';
import {
	getStats,
	recordComplaint,
	recordDelivery,
} from '../../intelligence/campaignComplaintRate.js';
import { recordOutcome } from '../../intelligence/circuitBreaker.js';
import { durableEffectIdentity } from '../../lib/effectCheckpoint.js';
import { recordDefer, throttleStateKey } from '../../intelligence/domainThrottle.js';
import { getDomainHealth, recordResponse } from '../../intelligence/smtpResponse.js';
import { recordBounce } from '../../intelligence/warming.js';
import { recordDomainFailure, shouldBackoffDomain } from '../../scaling/degradation.js';

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

	it('uses one Cluster-safe v2 key for reservation, effects, release, and completion', async () => {
		const first = await reserveComplaint(cluster as never, 'cluster-complaint');
		if (first.kind !== 'reserved') throw new Error('expected reservation');
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

	it('accepts owned-v2 after quiescence even while a legacy marker remains', async () => {
		await cluster.set('mta:fbl:dedup:shadow-cluster-complaint', '1', 'EX', 60);
		const result = await reserveComplaint(cluster as never, 'shadow-cluster-complaint');
		if (result.kind !== 'reserved') throw new Error('expected reservation');
		expect(await cluster.hget(result.reservation.key, 'version')).toBe('2');
	}, 15_000);

	it('does not mutate or refresh a residual legacy key while reserving v2', async () => {
		const key = 'mta:fbl:dedup:legacy-cluster-complaint';
		await cluster.set(key, '1', 'EX', 60);
		const before = await cluster.ttl(key);
		expect((await reserveComplaint(cluster as never, 'legacy-cluster-complaint')).kind).toBe(
			'reserved'
		);
		expect(await cluster.get(key)).toBe('1');
		expect(await cluster.ttl(key)).toBeGreaterThanOrEqual(before - 1);
	}, 15_000);

	it('applies each downstream control once when an old-success marker is replayed', async () => {
		const complaint = `legacy-success-${suffix}`;
		await cluster.set(`mta:fbl:dedup:${complaint}`, '1', 'EX', 60);
		const campaign = `campaign-${suffix}`;
		await recordDelivery(cluster as never, campaign, 1000);
		const applyControls = async (reservation: ComplaintDedupReservation) => {
			await runComplaintEffect(
				cluster as never,
				reservation,
				'campaign-complaint-rate',
				(identity) => recordComplaint(cluster as never, campaign, identity)
			);
			await runComplaintEffect(cluster as never, reservation, 'circuit-breaker', (identity) =>
				recordOutcome(
					cluster as never,
					`org-${suffix}`,
					'complained',
					undefined,
					'gmail',
					undefined,
					identity
				)
			);
		};

		const first = await reserveComplaint(cluster as never, complaint);
		if (first.kind !== 'reserved') throw new Error('expected reservation');
		await applyControls(first.reservation);
		await releaseComplaint(cluster as never, first.reservation);
		const retry = await reserveComplaint(cluster as never, complaint);
		if (retry.kind !== 'reserved') throw new Error('expected retry reservation');
		await applyControls(retry.reservation);
		await completeComplaint(cluster as never, retry.reservation);

		expect((await getStats(cluster as never, campaign)).complaints).toBe(1);
		expect(await cluster.llen(`mta:breaker:{org-${suffix}}:outcomes`)).toBe(1);
		expect(await cluster.llen(`mta:breaker:{org-${suffix}:provider:gmail}:outcomes`)).toBe(1);
	}, 15_000);

	it('keeps every dispatch control atomic and idempotent on Cluster', async () => {
		const campaign = `dispatch${suffix}`;
		const identity = durableEffectIdentity(`cluster-dispatch:${suffix}`, 'control');
		for (let replay = 0; replay < 2; replay++) {
			await recordDelivery(cluster as never, campaign, 1, identity);
			await recordDefer(cluster as never, '192.0.2.20', 'gmail.com', 'gmail', identity);
			await recordResponse(cluster as never, 'gmail.com', 421, '4.7.0', identity);
			await recordBounce(cluster as never, '192.0.2.20', identity);
			await recordDomainFailure(cluster as never, 'example.com', identity);
		}

		expect((await getStats(cluster as never, campaign)).delivered).toBe(1);
		expect(await cluster.hget(throttleStateKey('192.0.2.20', 'gmail.com'), 'recentDefers')).toBe(
			'1'
		);
		expect(await getDomainHealth(cluster as never, 'gmail.com')).toMatchObject({
			totalSent: 1,
			total4xx: 1,
		});
		expect(
			await cluster.hget(
				`mta:warming:{warming:192.0.2.20}:daily:${new Date().toISOString().slice(0, 10)}`,
				'bounced'
			)
		).toBe('1');
		expect(
			(await shouldBackoffDomain(cluster as never, 'example.com')).retryAfter
		).toBeLessThanOrEqual(30_000);
	}, 15_000);
});
