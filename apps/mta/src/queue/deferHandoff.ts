import { createHash } from 'crypto';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { EmailJob } from '../types.js';

interface DeferredHandoffReceipt {
	state: 'reserved' | 'accepted';
	messageId: string;
	successorJobId: string;
	groupId: string;
	delay: number;
	reservedAt: number;
	acceptedAt?: number;
}

/**
 * The single receipt slot owned by one delivery job's whole defer chain.
 *
 * A retry ladder is a chain of jobs: each defer enqueues a successor whose id
 * is derived from its predecessor's, and every link needs a durable receipt so
 * a redelivered predecessor cannot fork a second successor. Keying that receipt
 * by the *successor* minted one key per defer, each pinned for the full
 * four-day message lifetime with nothing but the TTL to reclaim it — a message
 * looping on a 60s defer left ~5,700 orphans behind it.
 *
 * The receipt is keyed by the CHAIN instead, so a ladder of any length occupies
 * exactly one key that each defer overwrites in place. What the slot holds is
 * "the furthest handoff this chain has committed", which is the question every
 * reader here actually asks.
 */
function handoffKey(chainId: string): string {
	return `mta:defer-handoffs:${chainId}`;
}

function deferredJobId(predecessorJobId: string): string {
	return `defer-${createHash('sha256').update(predecessorJobId).digest('hex')}`;
}

/**
 * The chain a job writes its handoffs under.
 *
 * Stamped onto every successor at handoff time, so only the root of a ladder
 * derives one. The `chain-` prefix keeps a derived id out of the `defer-<hex>`
 * namespace job ids live in, so a chain slot can never collide with a
 * per-successor receipt written before chains existed.
 */
function deferChainId(job: EmailJob, predecessorJobId: string): string {
	return job.deferChainId ?? `chain-${createHash('sha256').update(predecessorJobId).digest('hex')}`;
}

function parseReceipt(raw: string | null): DeferredHandoffReceipt | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			(value['state'] === 'reserved' || value['state'] === 'accepted') &&
			typeof value['messageId'] === 'string' &&
			typeof value['successorJobId'] === 'string' &&
			typeof value['groupId'] === 'string' &&
			typeof value['delay'] === 'number' &&
			typeof value['reservedAt'] === 'number' &&
			(value['acceptedAt'] === undefined || typeof value['acceptedAt'] === 'number')
		) {
			return value as unknown as DeferredHandoffReceipt;
		}
	} catch {
		// Corrupt handoffs fail closed in their caller.
	}
	return null;
}

/** Overwrite `key` only while it still holds `expected`. */
const CAS_SET =
	"if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 end return 0";

async function markAccepted(
	redis: Redis,
	key: string,
	raw: string,
	receipt: DeferredHandoffReceipt
): Promise<boolean> {
	const accepted = JSON.stringify({ ...receipt, state: 'accepted', acceptedAt: Date.now() });
	return (
		((await redis.eval(
			CAS_SET,
			1,
			key,
			raw,
			accepted,
			String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
		)) as number) === 1
	);
}

/**
 * Claim the chain slot for a new handoff.
 *
 * From the second link onwards the slot is not empty — it holds the receipt
 * that spawned the job doing the claiming — so the reservation replaces that
 * exact value instead of claiming a free key. Both forms are compare-and-set:
 * losing the race means another runner advanced the chain, which the resume
 * path settles.
 */
async function claimChainSlot(
	redis: Redis,
	key: string,
	priorRaw: string | null,
	raw: string
): Promise<boolean> {
	if (priorRaw === null) {
		return (await redis.set(key, raw, 'PX', GOVERNED_MTA_MAX_MESSAGE_AGE_MS, 'NX')) === 'OK';
	}
	return (
		((await redis.eval(
			CAS_SET,
			1,
			key,
			priorRaw,
			raw,
			String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
		)) as number) === 1
	);
}

/** Promote a successor before it can SMTP-send or complete. */
export async function promoteDeferredHandoff(redis: Redis, job: EmailJob): Promise<void> {
	if (!job.deferHandoffId) return;
	// Jobs enqueued before chains existed carry only `deferHandoffId`, which is
	// the per-successor key their receipt was written under. Reading it there
	// lets an in-flight ladder drain without a migration; its own successor is
	// stamped with a chain id and joins the bounded scheme.
	const key = handoffKey(job.deferChainId ?? job.deferHandoffId);
	const raw = await redis.get(key);
	const receipt = parseReceipt(raw);
	if (
		!raw ||
		!receipt ||
		receipt.messageId !== job.messageId ||
		receipt.successorJobId !== job.deferHandoffId
	) {
		throw new Error('Deferred handoff is missing or bound to another message');
	}
	if (receipt.state === 'accepted') return;
	if (!(await markAccepted(redis, key, raw, receipt))) {
		const raced = parseReceipt(await redis.get(key));
		if (raced?.state === 'accepted' && raced.messageId === job.messageId) return;
		throw new Error('Deferred handoff promotion lost its ownership');
	}
}

async function enqueueExactSuccessor(
	queue: Queue<EmailJob>,
	job: EmailJob,
	chainId: string,
	receipt: DeferredHandoffReceipt
): Promise<void> {
	await queue.add({
		groupId: receipt.groupId,
		data: { ...job, deferChainId: chainId, deferHandoffId: receipt.successorJobId },
		delay: receipt.delay,
		jobId: receipt.successorJobId,
	});
}

/**
 * Settle a redelivery whose handoff was committed before chains existed.
 *
 * The pre-chain scheme wrote the receipt under the SUCCESSOR's id, so a job
 * that handed off just before the upgrade restart left nothing in the chain
 * slot the reader below consults. Left at that, the chain reader calls the
 * handoff missing, the job falls through to `promote` — which either has no
 * receipt id to check (a root) or finds its own pre-chain receipt accepted (a
 * mid-ladder rung) — and dispatches while its successor sits queued: the exact
 * fork the receipt exists to prevent. So read the rung key the job actually
 * wrote, and apply the rule that wrote it.
 *
 * Only reachable for a job with no `deferChainId`, and only ever finds a
 * receipt this MTA wrote before the upgrade: nothing in the chain scheme
 * reserves a `defer-<hex>` key, it only reads the one a legacy rung left.
 */
async function resumePreChainHandoff(
	redis: Redis,
	queue: Queue<EmailJob>,
	predecessorJobId: string,
	job: EmailJob
): Promise<boolean> {
	const successorJobId = deferredJobId(predecessorJobId);
	const key = handoffKey(successorJobId);
	const raw = await redis.get(key);
	if (!raw) return false;
	const receipt = parseReceipt(raw);
	if (
		!receipt ||
		receipt.messageId !== job.messageId ||
		receipt.successorJobId !== successorJobId
	) {
		throw new Error('Deferred handoff receipt is corrupt or identity-mismatched');
	}
	if (receipt.state === 'accepted') return true;
	if (!(await queue.getJob(successorJobId).catch(() => null))) {
		// Re-enqueued WITHOUT a chain stamp, so the successor's own promotion
		// keeps reading the rung key this receipt lives under. It stamps a chain
		// on the rung after it and the ladder rejoins the bounded scheme there.
		await queue.add({
			groupId: receipt.groupId,
			data: { ...job, deferHandoffId: receipt.successorJobId },
			delay: receipt.delay,
			jobId: receipt.successorJobId,
		});
	}
	await markAccepted(redis, key, raw, receipt);
	return true;
}

/**
 * Stop a predecessor retry from forking after a committed/lost handoff. A
 * queued successor is authoritative before start; its promoted receipt remains
 * authoritative after completion and GroupMQ trimming.
 */
export async function resumeDeferredHandoff(
	redis: Redis,
	queue: Queue<EmailJob>,
	predecessorJobId: string,
	job: EmailJob
): Promise<boolean> {
	const chainId = deferChainId(job, predecessorJobId);
	const key = handoffKey(chainId);
	const raw = await redis.get(key);
	if (!raw) {
		if (job.deferChainId) return false;
		return resumePreChainHandoff(redis, queue, predecessorJobId, job);
	}
	const receipt = parseReceipt(raw);
	if (!receipt || receipt.messageId !== job.messageId) {
		throw new Error('Deferred handoff receipt is corrupt or identity-mismatched');
	}
	const successorJobId = deferredJobId(predecessorJobId);
	if (receipt.successorJobId !== successorJobId) {
		// The slot advances monotonically, so a receipt that is not this job's
		// successor is either the one that spawned it — the ladder has not moved
		// past this job and it still owns its defer disposition — or a LATER
		// link, which means this job already handed off and re-dispatching would
		// send the message twice.
		return receipt.successorJobId !== job.deferHandoffId;
	}
	if (receipt.state === 'accepted') return true;
	const queued = await queue.getJob(successorJobId).catch(() => null);
	if (queued) {
		await markAccepted(redis, key, raw, receipt);
		return true;
	}
	await enqueueExactSuccessor(queue, job, chainId, receipt);
	await markAccepted(redis, key, raw, receipt);
	return true;
}

/** Reserve and enqueue the exact successor before the predecessor may ACK. */
export async function handoffDeferredJob(
	redis: Redis,
	queue: Queue<EmailJob>,
	predecessorJobId: string,
	job: EmailJob,
	groupId: string,
	delay: number
): Promise<void> {
	const chainId = deferChainId(job, predecessorJobId);
	const key = handoffKey(chainId);
	const successorJobId = deferredJobId(predecessorJobId);
	const receipt: DeferredHandoffReceipt = {
		state: 'reserved',
		messageId: job.messageId,
		successorJobId,
		groupId,
		delay,
		reservedAt: Date.now(),
	};
	const raw = JSON.stringify(receipt);
	const priorRaw = await redis.get(key);
	const prior = parseReceipt(priorRaw);
	// Only an empty slot or this job's own inbound receipt may be claimed.
	// Anything else is a chain that has already moved on, and overwriting it
	// would rewind a committed handoff back to `reserved`.
	const claimable =
		priorRaw === null ||
		(prior !== null &&
			prior.messageId === job.messageId &&
			prior.successorJobId === job.deferHandoffId);
	if (!claimable || !(await claimChainSlot(redis, key, priorRaw, raw))) {
		if (await resumeDeferredHandoff(redis, queue, predecessorJobId, job)) return;
		throw new Error('Deferred handoff reservation unavailable');
	}
	try {
		await enqueueExactSuccessor(queue, job, chainId, receipt);
		if (!(await markAccepted(redis, key, raw, receipt))) {
			if (!(await isCommittedSuccessor(redis, key, successorJobId))) {
				throw new Error('Deferred handoff acceptance lost');
			}
		}
	} catch (error) {
		const queued = await queue.getJob(successorJobId).catch(() => null);
		if (queued || (await isCommittedSuccessor(redis, key, successorJobId))) return;
		throw error;
	}
}

/** True once the chain slot records THIS successor as accepted. */
async function isCommittedSuccessor(
	redis: Redis,
	key: string,
	successorJobId: string
): Promise<boolean> {
	const current = parseReceipt(await redis.get(key));
	return current?.state === 'accepted' && current.successorJobId === successorJobId;
}
