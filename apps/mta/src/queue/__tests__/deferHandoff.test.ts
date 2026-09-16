/**
 * The defer-handoff receipt is the MTA's anti-fork guard: it records that a
 * deferring job has durably committed its successor, so a redelivered
 * predecessor cannot enqueue a second one and send the message twice.
 *
 * These tests pin both halves of that contract — the guard itself, and the
 * bound on how much Redis it may occupy while providing it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import Redis from 'ioredis-mock';
import type { Queue } from 'groupmq';
import type { EmailJob } from '../../types.js';
import {
	handoffDeferredJob,
	promoteDeferredHandoff,
	resumeDeferredHandoff,
} from '../deferHandoff.js';

const GROUP_ID = 'transactional:example.com';
const DELAY_MS = 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const successorOf = (jobId: string) => `defer-${sha256(jobId)}`;
const chainOf = (rootJobId: string) => `chain-${sha256(rootJobId)}`;
const handoffKey = (chainId: string) => `mta:defer-handoffs:${chainId}`;

function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-001',
		intakeReceiptId: 'work-attempt-1',
		to: 'user@example.com',
		from: 'sender@acme.test',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'acme.test',
		...overrides,
	};
}

/** Records every `add` and serves `getJob` from what was actually enqueued. */
function createQueueStub() {
	const added: { jobId: string; data: EmailJob; groupId: string; delay: number }[] = [];
	const stub = {
		add: vi.fn(
			async (options: { jobId: string; data: EmailJob; groupId: string; delay: number }) => {
				added.push(options);
				return { id: options.jobId };
			}
		),
		getJob: vi.fn(async (jobId: string) => added.find((job) => job.jobId === jobId) ?? null),
	};
	return { stub, added, queue: stub as unknown as Queue<EmailJob> };
}

describe('deferred handoff receipts', () => {
	let redis: InstanceType<typeof Redis>;
	let queue: Queue<EmailJob>;
	let stub: ReturnType<typeof createQueueStub>['stub'];
	let added: ReturnType<typeof createQueueStub>['added'];

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		({ queue, stub, added } = createQueueStub());
	});

	const liveReceipts = () => redis.keys('mta:defer-handoffs:*');

	/** Defer `job` (running as `jobId`) and return the successor it committed. */
	async function defer(jobId: string, job: EmailJob) {
		await handoffDeferredJob(redis as never, queue, jobId, job, GROUP_ID, DELAY_MS);
		const committed = added[added.length - 1]!;
		return { jobId: committed.jobId, data: committed.data };
	}

	it('keys one receipt per chain, not per rung', async () => {
		let link = { jobId: 'root-job', data: createJob() };
		for (let rung = 0; rung < 10; rung++) {
			link = await defer(link.jobId, link.data);
			await promoteDeferredHandoff(redis as never, link.data);
			expect(await liveReceipts()).toEqual([handoffKey(chainOf('root-job'))]);
		}
	});

	it('refuses to fork when a predecessor is redelivered after the chain moved on', async () => {
		const root = createJob();
		const first = await defer('root-job', root);
		await promoteDeferredHandoff(redis as never, first.data);
		await defer(first.jobId, first.data);
		expect(added).toHaveLength(2);

		// The root stalled without ACKing and GroupMQ handed it back. Its own
		// successor has since deferred again, so the slot no longer names it.
		await expect(resumeDeferredHandoff(redis as never, queue, 'root-job', root)).resolves.toBe(
			true
		);
		expect(added).toHaveLength(2);
	});

	it('lets a promoted job own its disposition until it has actually handed off', async () => {
		const first = await defer('root-job', createJob());
		await promoteDeferredHandoff(redis as never, first.data);

		// The slot holds the receipt that spawned this job, not one it wrote.
		await expect(
			resumeDeferredHandoff(redis as never, queue, first.jobId, first.data)
		).resolves.toBe(false);
	});

	it('reconciles a replayed handoff onto the same successor instead of a second one', async () => {
		const root = createJob();
		const first = await defer('root-job', root);

		await handoffDeferredJob(redis as never, queue, 'root-job', root, GROUP_ID, DELAY_MS);
		expect(added).toHaveLength(1);
		expect(first.jobId).toBe(successorOf('root-job'));

		const receipt = JSON.parse((await redis.get(handoffKey(chainOf('root-job'))))!) as {
			state: string;
		};
		expect(receipt.state).toBe('accepted');
	});

	it('re-enqueues the exact successor when the committing add lost its response', async () => {
		const root = createJob();
		stub.add.mockRejectedValueOnce(new Error('successor committed; response lost'));
		await expect(
			handoffDeferredJob(redis as never, queue, 'root-job', root, GROUP_ID, DELAY_MS)
		).rejects.toThrow('response lost');

		await expect(resumeDeferredHandoff(redis as never, queue, 'root-job', root)).resolves.toBe(
			true
		);
		expect(added).toHaveLength(1);
		expect(added[0]!.jobId).toBe(successorOf('root-job'));
	});

	it('rejects a promotion whose receipt is bound to another message', async () => {
		const first = await defer('root-job', createJob());
		await expect(
			promoteDeferredHandoff(redis as never, { ...first.data, messageId: 'msg-other' })
		).rejects.toThrow('bound to another message');
	});

	it('rejects a promotion whose receipt is gone', async () => {
		const first = await defer('root-job', createJob());
		await redis.del(handoffKey(chainOf('root-job')));
		await expect(promoteDeferredHandoff(redis as never, first.data)).rejects.toThrow(
			'missing or bound to another message'
		);
	});

	it('drains a job enqueued before chains existed through its per-successor key', async () => {
		// Exactly what an in-flight ladder looks like across the deploy: a job
		// carrying only the successor id its receipt was written under.
		const legacyJobId = successorOf('pre-deploy-job');
		const legacy = createJob({ deferHandoffId: legacyJobId });
		await redis.set(
			handoffKey(legacyJobId),
			JSON.stringify({
				state: 'accepted',
				messageId: legacy.messageId,
				successorJobId: legacyJobId,
				groupId: GROUP_ID,
				delay: DELAY_MS,
				reservedAt: Date.now(),
				acceptedAt: Date.now(),
			})
		);

		await expect(promoteDeferredHandoff(redis as never, legacy)).resolves.toBeUndefined();

		// Its own successor joins the bounded scheme under a fresh chain slot.
		const next = await defer(legacyJobId, legacy);
		expect(next.data.deferChainId).toBe(chainOf(legacyJobId));
		expect((await liveReceipts()).sort()).toEqual(
			[handoffKey(legacyJobId), handoffKey(chainOf(legacyJobId))].sort()
		);
	});
});
