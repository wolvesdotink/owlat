/**
 * `keepFailed` must actually bound `<ns>:failed`.
 *
 * GroupMQ ships `record-job-result.lua` with the failure branch deliberately
 * untrimmed — "No retention trimming for failed jobs (let clean() handle it)" —
 * and nothing in this repository has ever called `queue.clean()`. So the
 * `keepFailed: 5000` in `createEmailQueue` was inert: `groupmq:owlat-mta:failed`
 * and one job hash per dead-lettered message (holding the whole `EmailJob`,
 * `html` included) grew forever. `patches/groupmq@1.1.0.patch` makes the failure
 * branch trim the way the completion branch already did.
 *
 * This suite runs the REAL, patched Lua out of `node_modules` rather than a
 * re-implementation, so it fails if the patch stops applying (a groupmq bump, a
 * dropped `patchedDependencies` entry) — which is the whole point of having it.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createEmailQueue } from '../setup.js';

const require_ = createRequire(import.meta.url);

const RECORD_JOB_RESULT_LUA = readFileSync(
	require_
		.resolve('groupmq/package.json')
		.replace(/package\.json$/, 'dist/lua/record-job-result.lua'),
	'utf8'
);

/**
 * Real Redis exposes `cjson`; ioredis-mock's Lua VM does not. The failure
 * branch only ever decodes the `{message,name,stack}` envelope groupmq itself
 * serialises, so a three-field shim is enough to run the shipped script
 * unmodified — the bytes under test stay the bytes that ship.
 */
const CJSON_SHIM = `
if not cjson then
  cjson = {
    decode = function(raw)
      return {
        message = string.match(raw, '"message":"(.-)"'),
        name = string.match(raw, '"name":"(.-)"'),
        stack = string.match(raw, '"stack":"(.-)"'),
      }
    end,
  }
end
`;

const NS = 'groupmq:owlat-mta';
const KEEP_COMPLETED = 1000;

/** A stand-in for the `html` an EmailJob carries into its failed job hash. */
const FAT_PAYLOAD = 'x'.repeat(4096);

describe('failed-job retention', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		// ioredis-mock hands every `new Redis()` the same keyspace.
		await redis.flushall();
	});

	/** Seed a job hash the way `enqueue.lua` + `reserve.lua` leave it. */
	async function reserveJob(jobId: string): Promise<void> {
		await redis.hset(`${NS}:job:${jobId}`, 'status', 'processing', 'data', FAT_PAYLOAD);
		await redis.set(`${NS}:unique:${jobId}`, jobId);
	}

	async function recordFinalFailure(
		jobId: string,
		finishedOn: number,
		keepFailed: number
	): Promise<void> {
		await redis.eval(
			`${CJSON_SHIM}\n${RECORD_JOB_RESULT_LUA}`,
			1,
			NS,
			jobId,
			'failed',
			String(finishedOn),
			JSON.stringify({ message: 'permanent 550', name: 'Error', stack: '' }),
			String(KEEP_COMPLETED),
			String(keepFailed),
			String(finishedOn - 10),
			String(finishedOn),
			'5',
			'5'
		);
	}

	it('trims the failed set to keepFailed and deletes the jobs it evicted', async () => {
		const keepFailed = 3;
		for (let index = 0; index < 8; index += 1) {
			const jobId = `job-${index}`;
			await reserveJob(jobId);
			await recordFinalFailure(jobId, 1_000 + index, keepFailed);
		}

		// Only the newest `keepFailed` survive, newest-last by finishedOn score.
		expect(await redis.zrange(`${NS}:failed`, 0, -1)).toEqual(['job-5', 'job-6', 'job-7']);
		expect(await redis.zcard(`${NS}:failed`)).toBe(keepFailed);
	});

	it('reclaims the bytes, not just the set membership', async () => {
		const keepFailed = 2;
		for (let index = 0; index < 5; index += 1) {
			const jobId = `job-${index}`;
			await reserveJob(jobId);
			await recordFinalFailure(jobId, 2_000 + index, keepFailed);
		}

		// The evicted jobs' hashes — which hold the full EmailJob payload — and
		// their idempotence mappings are gone, not merely unreferenced.
		for (const evicted of ['job-0', 'job-1', 'job-2']) {
			expect(await redis.exists(`${NS}:job:${evicted}`)).toBe(0);
			expect(await redis.exists(`${NS}:unique:${evicted}`)).toBe(0);
		}
		for (const kept of ['job-3', 'job-4']) {
			expect(await redis.hget(`${NS}:job:${kept}`, 'status')).toBe('failed');
			expect(await redis.hget(`${NS}:job:${kept}`, 'data')).toBe(FAT_PAYLOAD);
		}
	});

	it('keeps the failure metadata on the jobs it retains', async () => {
		await reserveJob('job-a');
		await recordFinalFailure('job-a', 3_000, 5);
		expect(await redis.hget(`${NS}:job:job-a`, 'failedReason')).toBe('permanent 550');
		expect(await redis.hget(`${NS}:job:job-a`, 'attempts')).toBe('5');
	});

	it('still deletes outright when retention is switched off', async () => {
		await reserveJob('job-z');
		await recordFinalFailure('job-z', 4_000, 0);
		expect(await redis.exists(`${NS}:job:job-z`)).toBe(0);
		expect(await redis.zcard(`${NS}:failed`)).toBe(0);
	});

	it('is reached by the queue the MTA actually builds', () => {
		// A retention bound only bounds anything while `keepFailed > 0` — at zero
		// the script takes the delete-immediately branch instead, and this suite
		// would be guarding a path production never runs.
		const queue = createEmailQueue(redis) as unknown as { keepFailed: number };
		expect(queue.keepFailed).toBeGreaterThan(0);
	});
});
