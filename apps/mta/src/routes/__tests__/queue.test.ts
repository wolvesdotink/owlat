/**
 * THE QUEUE INSPECTOR HAS TO BE POINTED AT THE QUEUE.
 *
 * These routes spent their whole life reading Redis keys nothing writes: a
 * `:pending` LIST, an `:active` SET, an un-prefixed `owlat-mta:` namespace
 * where GroupMQ writes `groupmq:owlat-mta:`. Every endpoint answered — zeros,
 * empty lists, 404s, "nothing removed" — and every answer was wrong, including
 * while the delay set held six million entries and `/queue/stats` reported
 * `delayed: 0`.
 *
 * A test that stubbed the queue would have reproduced that bug perfectly, so
 * these drive the routes against a REAL `Queue` (the same class, the same Lua,
 * the same namespace the MTA configures) backed by ioredis-mock. The load-
 * bearing assertions are the ones that would be satisfied by a queue containing
 * nothing: each one puts known work into the queue and demands the endpoint
 * find it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import { withLuaScripting } from '../../__tests__/helpers/luaScriptedRedisMock.js';
import { withScriptCacheRecovery } from '../../lib/redisScriptCache.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createQueueRoutes } = await import('../queue.js');
const { QUEUE_NAMESPACE } = await import('../../queue/setup.js');
const { QUEUE_KEY_NAMESPACE } = await import('../../queue/delayedOrphans.js');
const { logger } = await import('../../monitoring/logger.js');

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as MtaConfig;

const DELAYED_KEY = `${QUEUE_KEY_NAMESPACE}:delayed`;
const BODY = '<p>secret body copy</p>';

let redis: InstanceType<typeof RedisMock>;
let queue: Queue<EmailJob>;

function emailJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-1',
		to: 'someone@example.com',
		from: 'noreply@acme.test',
		subject: 'Hello',
		html: BODY,
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'acme.test',
		...overrides,
	} as EmailJob;
}

/** Enqueue a job into the group key the dispatcher would have used. */
async function enqueue(
	jobId: string,
	overrides: Partial<EmailJob> = {},
	opts: { delay?: number } = {}
): Promise<void> {
	const data = emailJob(overrides);
	const domain = data.to.split('@')[1];
	await queue.add({
		groupId: `${data.ipPool}:${domain}`,
		data,
		jobId,
		...(opts.delay === undefined ? {} : { delay: opts.delay }),
	});
}

function request(method: string, path: string, auth = true): Promise<Response> {
	return createQueueRoutes(queue, redis as unknown as Redis, config).request(path, {
		method,
		headers: auth ? { Authorization: `Bearer ${API_KEY}` } : {},
	});
}

async function json(method: string, path: string): Promise<{ status: number; body: any }> {
	const res = await request(method, path);
	return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
	vi.clearAllMocks();
	redis = new RedisMock();
	await redis.flushall();
	withLuaScripting(redis);
	// The namespace the MTA really configures — the mismatch between this and
	// what the routes read is the entire defect under repair, so the test is
	// not allowed to pick a convenient one.
	queue = new Queue<EmailJob>({
		redis: withScriptCacheRecovery(redis as never),
		namespace: QUEUE_NAMESPACE,
		jobTimeoutMs: 120_000,
		maxAttempts: 5,
		keepCompleted: 1000,
		keepFailed: 5000,
	});
});

describe('GET /stats', () => {
	it('counts work that is actually in the queue', async () => {
		await enqueue('waiting-1');
		await enqueue('waiting-2', { to: 'other@mail.example' });
		await enqueue('later', { to: 'third@mail.example' }, { delay: 60_000 });
		await enqueue('running', { to: 'fourth@run.example' });
		await queue.reserve();

		const { status, body } = await json('GET', '/stats');

		expect(status).toBe(200);
		// Every one of these read 0 before: the endpoint was looking at keys
		// GroupMQ has never written.
		// Four jobs in, one reserved: three are still held in a group.
		expect(body.waiting).toBe(3);
		expect(body.active).toBe(1);
		expect(body.delayed).toBe(1);
		expect(body.groups).toBeGreaterThan(0);
	});

	it('reports delayed as a subset of waiting, not a sibling of it', async () => {
		// GroupMQ leaves a delayed job in its group as well as in the delay set.
		// Pinned because the alternative reading — that the states partition —
		// turns `waiting + delayed` into a queue depth that overcounts.
		await enqueue('now');
		await enqueue('later', { to: 'other@mail.example' }, { delay: 60_000 });

		const { body } = await json('GET', '/stats');

		expect(body.waiting).toBe(2);
		expect(body.delayed).toBe(1);
	});

	it('reports an empty queue as empty rather than by accident', async () => {
		const { body } = await json('GET', '/stats');

		expect(body).toMatchObject({ waiting: 0, active: 0, delayed: 0, groups: 0 });
	});

	it('agrees with the delay set /health reads', async () => {
		await enqueue('later-1', {}, { delay: 60_000 });
		await enqueue('later-2', { to: 'other@mail.example' }, { delay: 60_000 });

		const { body } = await json('GET', '/stats');

		expect(body.delayed).toBe(await redis.zcard(DELAYED_KEY));
		// One delayed number in the payload, so the two cannot drift apart.
		expect(body.delayedQueue).not.toHaveProperty('delayed');
	});

	it('surfaces a stranded delay-set member the way /health does', async () => {
		await enqueue('orphan', {}, { delay: 60_000 });
		await redis.del(`${QUEUE_KEY_NAMESPACE}:job:orphan`);
		await redis.zadd(DELAYED_KEY, String(Date.now() - 60 * 60_000), 'orphan');

		const { body } = await json('GET', '/stats');

		expect(body.delayedQueue.status).toBe('orphaned');
		expect(body.delayedQueue.orphaned).toBe(1);
	});
});

describe('GET /pending', () => {
	it('lists the jobs waiting in the queue', async () => {
		await enqueue('a', { messageId: 'm-a' });
		await enqueue('b', { messageId: 'm-b', to: 'b@mail.example' });

		const { status, body } = await json('GET', '/pending');

		expect(status).toBe(200);
		// Previously always `[]`, whatever the queue held.
		expect(body.jobs.map((j: { jobId: string }) => j.jobId).sort()).toEqual(['a', 'b']);
		expect(body.waiting).toBe(2);
		expect(body.sampled).toBe(2);
		const first = body.jobs.find((j: { jobId: string }) => j.jobId === 'a');
		expect(first).toMatchObject({
			messageId: 'm-a',
			to: 'someone@example.com',
			organizationId: 'org-1',
			groupId: 'transactional:example.com',
		});
	});

	it('lists a delayed job without claiming to know its state', async () => {
		// GroupMQ's waiting scan reads group ZSETs, which still hold delayed
		// jobs. Listing them is right — they are queued mail — but labelling
		// them `waiting` would be a guess, so the listing makes no such claim.
		await enqueue('later', {}, { delay: 60_000 });

		const { body } = await json('GET', '/pending');

		expect(body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['later']);
		expect(body.jobs[0]).not.toHaveProperty('state');
		// The per-job endpoint does resolve it.
		expect((await json('GET', '/jobs/later')).body.state).toBe('delayed');
	});

	it('filters by recipient domain', async () => {
		await enqueue('keep', { to: 'a@keep.example' });
		await enqueue('drop', { to: 'b@drop.example' });

		const { body } = await json('GET', '/pending?domain=KEEP.example');

		expect(body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['keep']);
		expect(body.domain).toBe('keep.example');
		// The sample is reported unfiltered so a caller can see the filter ran
		// against a partial view of the queue rather than the whole of it.
		expect(body.sampled).toBe(2);
	});

	it('says how much of the queue the sample missed', async () => {
		for (let i = 0; i < 5; i++) {
			await enqueue(`job-${i}`, { to: `user-${i}@mail-${i}.example` });
		}

		const { body } = await json('GET', '/pending?limit=2');

		expect(body.jobs.length).toBeLessThanOrEqual(2);
		expect(body.waiting).toBe(5);
		expect(body.limit).toBe(2);
	});

	it('falls back to the default limit for a nonsense one', async () => {
		await enqueue('a');

		expect((await json('GET', '/pending?limit=abc')).body.limit).toBe(50);
		expect((await json('GET', '/pending?limit=-4')).body.limit).toBe(50);
		expect((await json('GET', '/pending?limit=99999')).body.limit).toBe(200);
	});

	it('does not pour message bodies through an inspection endpoint', async () => {
		await enqueue('a');

		const res = await request('GET', '/pending');

		expect(await res.text()).not.toContain('secret body copy');
	});
});

describe('GET /jobs/:jobId', () => {
	it('finds a job that is in the queue', async () => {
		await enqueue('wanted', { messageId: 'm-wanted' });

		const { status, body } = await json('GET', '/jobs/wanted');

		// Previously a 404 for every job that has ever existed.
		expect(status).toBe(200);
		expect(body).toMatchObject({
			jobId: 'wanted',
			state: 'waiting',
			messageId: 'm-wanted',
			attempts: 0,
			maxAttempts: 5,
		});
		expect(body.bytes.html).toBe(BODY.length);
	});

	it('reports the delay a retrying job is sitting out', async () => {
		await enqueue('later', {}, { delay: 60_000 });

		const { body } = await json('GET', '/jobs/later');

		expect(body.state).toBe('delayed');
		expect(body.delayMs).toBeGreaterThan(0);
	});

	it('404s for a job id nothing knows', async () => {
		const { status, body } = await json('GET', '/jobs/never-existed');

		expect(status).toBe(404);
		expect(body.error).toBe('Job not found');
	});

	it('does not return the message body', async () => {
		await enqueue('wanted');

		const res = await request('GET', '/jobs/wanted');

		expect(await res.text()).not.toContain('secret body copy');
	});
});

describe('DELETE /jobs/:jobId', () => {
	it('really removes the job', async () => {
		await enqueue('doomed');

		const { status, body } = await json('DELETE', '/jobs/doomed');

		expect(status).toBe(200);
		// The old handler reported `removed: false` and left the job in place;
		// reporting `removed: true` while leaving it in place would be worse.
		expect(body).toMatchObject({ removed: true, jobId: 'doomed', state: 'waiting' });
		expect(await queue.getWaitingCount()).toBe(0);
		expect(await redis.exists(`${QUEUE_KEY_NAMESPACE}:job:doomed`)).toBe(0);
	});

	it('logs what it destroyed', async () => {
		await enqueue('doomed', { messageId: 'm-doomed' });

		await json('DELETE', '/jobs/doomed');

		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: 'doomed',
				messageId: 'm-doomed',
				organizationId: 'org-1',
				state: 'waiting',
			}),
			expect.stringContaining('removed by operator')
		);
	});

	it('refuses a job a worker is already delivering, and leaves it alone', async () => {
		await enqueue('in-flight');
		const reserved = await queue.reserve();
		expect(reserved?.id).toBe('in-flight');

		const { status, body } = await json('DELETE', '/jobs/in-flight');

		// Removing it would not stop the SMTP conversation, only the record of it.
		expect(status).toBe(409);
		expect(body.state).toBe('active');
		expect(await redis.exists(`${QUEUE_KEY_NAMESPACE}:job:in-flight`)).toBe(1);
		expect(await queue.getActiveCount()).toBe(1);
	});

	it('removes a delayed job from the retry ladder', async () => {
		await enqueue('later', {}, { delay: 60_000 });

		expect((await json('DELETE', '/jobs/later')).status).toBe(200);

		expect(await redis.zcard(DELAYED_KEY)).toBe(0);
	});

	it('404s instead of claiming a removal it did not make', async () => {
		const { status, body } = await json('DELETE', '/jobs/never-existed');

		expect(status).toBe(404);
		expect(body.error).toBe('Job not found');
	});
});

describe('route surface', () => {
	it('no longer offers a bulk flush', async () => {
		await enqueue('survivor');

		const res = await request('POST', '/flush?orgId=org-1');

		expect(res.status).toBe(404);
		expect(await queue.getWaitingCount()).toBe(1);
	});

	it('requires the master key', async () => {
		await enqueue('a');

		for (const [method, path] of [
			['GET', '/stats'],
			['GET', '/pending'],
			['GET', '/jobs/a'],
			['DELETE', '/jobs/a'],
		] as const) {
			expect((await request(method, path, false)).status).toBe(401);
		}
		expect(await queue.getWaitingCount()).toBe(1);
	});
});
