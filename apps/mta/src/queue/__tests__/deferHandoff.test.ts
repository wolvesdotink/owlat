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

	/** A receipt in the shape the pre-chain scheme wrote: keyed by the successor. */
	async function writeLegacyReceipt(
		successorJobId: string,
		job: EmailJob,
		state: 'reserved' | 'accepted'
	) {
		await redis.set(
			handoffKey(successorJobId),
			JSON.stringify({
				state,
				messageId: job.messageId,
				successorJobId,
				groupId: GROUP_ID,
				delay: DELAY_MS,
				reservedAt: Date.now(),
				...(state === 'accepted' ? { acceptedAt: Date.now() } : {}),
			})
		);
	}

	it('stops a redelivered root whose handoff was committed before chains existed', async () => {
		// Killed between `handoffDeferredJob` resolving and `completeJob`, then
		// restarted onto the chain scheme. The root carries no chain stamp, so its
		// chain slot is empty — but its successor is queued and must not be forked.
		const root = createJob();
		const successorJobId = successorOf('root-job');
		await writeLegacyReceipt(successorJobId, root, 'accepted');
		await queue.add({
			groupId: GROUP_ID,
			data: { ...root, deferHandoffId: successorJobId },
			delay: DELAY_MS,
			jobId: successorJobId,
		});

		await expect(resumeDeferredHandoff(redis as never, queue, 'root-job', root)).resolves.toBe(
			true
		);
		expect(added).toHaveLength(1);
	});

	it('stops a redelivered legacy successor that had already handed off again', async () => {
		// Mid-ladder version of the same kill: the job holds its own pre-chain
		// receipt, and wrote a second one for the rung after it.
		const legacyJobId = successorOf('pre-deploy-job');
		const legacy = createJob({ deferHandoffId: legacyJobId });
		await writeLegacyReceipt(legacyJobId, legacy, 'accepted');
		const nextJobId = successorOf(legacyJobId);
		await writeLegacyReceipt(nextJobId, legacy, 'accepted');
		await queue.add({
			groupId: GROUP_ID,
			data: { ...legacy, deferHandoffId: nextJobId },
			delay: DELAY_MS,
			jobId: nextJobId,
		});

		await expect(resumeDeferredHandoff(redis as never, queue, legacyJobId, legacy)).resolves.toBe(
			true
		);
		expect(added).toHaveLength(1);
	});

	it('re-enqueues a pre-chain successor that was reserved but never committed', async () => {
		const root = createJob();
		const successorJobId = successorOf('root-job');
		await writeLegacyReceipt(successorJobId, root, 'reserved');

		await expect(resumeDeferredHandoff(redis as never, queue, 'root-job', root)).resolves.toBe(
			true
		);
		expect(added).toHaveLength(1);
		expect(added[0]!.jobId).toBe(successorJobId);
		// Unstamped, so the successor's own promotion still finds the rung receipt
		// that is sitting there waiting for it.
		expect(added[0]!.data.deferChainId).toBeUndefined();
		await expect(promoteDeferredHandoff(redis as never, added[0]!.data)).resolves.toBeUndefined();
	});

	it('leaves a job with no receipt in either scheme owning its disposition', async () => {
		await expect(
			resumeDeferredHandoff(redis as never, queue, 'root-job', createJob())
		).resolves.toBe(false);
	});
});
