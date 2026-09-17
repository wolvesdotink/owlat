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
const { QUEUE_NAMESPACE } = await import('../../queue/namespace.js');
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
		// Scoped to the domain, not to the whole queue: a filtered call reports
		// the domain's backlog, which is the number the operator asked about.
		expect(body.sampled).toBe(1);
		expect(body.waiting).toBe(1);
	});

	it('finds a domain backlog that the waiting scan would never have sampled', async () => {
		// GroupMQ's waiting scan reads `SMEMBERS <ns>:groups`, keeps the first
		// 100 group ids and reads a slice of each — so filtering its output in JS
		// answers "nothing queued for that domain" for any sender with more than
		// 100 `{ipPool}:{recipientDomain}` groups, which is every real one, and
		// certain during the runaway backlog this endpoint exists for. It is not
		// even a random sample: the same groups come back every poll.
		for (let i = 0; i < 150; i++) {
			await enqueue(`filler-${i}`, { to: `user@filler-${i}.example` });
		}
		for (let i = 0; i < 5; i++) {
			await enqueue(`backlog-${i}`, { to: `user-${i}@backlog.example` });
		}

		const { body } = await json('GET', '/pending?domain=backlog.example&limit=10');

		expect(body.jobs.map((j: { jobId: string }) => j.jobId).sort()).toEqual([
			'backlog-0',
			'backlog-1',
			'backlog-2',
			'backlog-3',
			'backlog-4',
		]);
		// And the count is the domain's real backlog, not what a sample saw.
		expect(body.waiting).toBe(5);
		expect(body.sampled).toBe(5);
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

	it('keeps an unreadable queue a 500 rather than flattening it into 404', async () => {
		// `isJobNotFound` matches GroupMQ's message exactly so that everything
		// else — a dropped connection, a NOSCRIPT — keeps its 500. A 404 here
		// would say "no such message" about a message nobody could read.
		vi.spyOn(queue, 'getJob').mockRejectedValue(new Error('Connection is closed.'));

		const { status, body } = await json('GET', '/jobs/anything');

		expect(status).toBe(500);
		expect(body.error).toBe('Failed to get job details');
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

	it('refuses a job a worker reserves between the state read and the removal', async () => {
		// The guard used to be a plain read-then-remove, and losing that race did
		// not merely delete an in-flight job: GroupMQ's `remove.lua` never touches
		// the per-group `:active` list that `reserve.lua` gates on, no completion
		// script cleans it once the job hash is gone, and `check-stalled.lua` only
		// looks at `:processing`, which `remove` already ZREM'd. The group wedges
		// permanently and every later message to that recipient domain sits in
		// `waiting` forever — busy-looking, not broken-looking.
		await enqueue('doomed');
		await enqueue('next', { messageId: 'm-next' });

		const readJob = queue.getJob.bind(queue);
		let reserved: Awaited<ReturnType<typeof queue.reserve>> = null;
		let raced = false;
		vi.spyOn(queue, 'getJob').mockImplementation(async (id: string) => {
			const job = await readJob(id);
			// A worker takes the head of the group in the window between the
			// route's state read and its removal.
			if (!raced) {
				raced = true;
				reserved = await queue.reserve();
			}
			return job;
		});

		const { status, body } = await json('DELETE', '/jobs/doomed');

		expect(status).toBe(409);
		expect(body.state).toBe('active');
		expect(reserved!.id).toBe('doomed');
		// The job survives, so the worker that holds it can settle it...
		expect(await redis.exists(`${QUEUE_KEY_NAMESPACE}:job:doomed`)).toBe(1);
		await queue.completeWithMetadata(reserved!, null, {
			processedOn: Date.now(),
			finishedOn: Date.now(),
			attempts: 1,
			maxAttempts: 5,
		});
		// ...and the group goes on draining. This is the assertion the endpoint
		// most needs: it fails with `undefined` when the active list is stranded.
		expect((await queue.reserve())?.id).toBe('next');
	});

	it('removes a delayed job from the retry ladder', async () => {
		await enqueue('later', {}, { delay: 60_000 });

		expect((await json('DELETE', '/jobs/later')).status).toBe(200);

		expect(await redis.zcard(DELAYED_KEY)).toBe(0);
	});

	it('does not answer 404 when the queue merely failed to remove', async () => {
		// `Queue.remove` catches its own Redis errors and returns `false`, so a
		// dropped connection or a NOSCRIPT is indistinguishable from "no such
		// job" at the call site. Reporting 404 would tell an operator the message
		// does not exist while it is still queued and about to be delivered.
		await enqueue('doomed');
		vi.spyOn(queue, 'remove').mockResolvedValue(false);

		const { status, body } = await json('DELETE', '/jobs/doomed');

		expect(status).toBe(500);
		expect(body.error).toBe('Failed to remove job');
		expect(await queue.getWaitingCount()).toBe(1);
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
