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

function handoffKey(successorJobId: string): string {
	return `mta:defer-handoffs:${successorJobId}`;
}

export function deferredJobId(predecessorJobId: string): string {
	return `defer-${createHash('sha256').update(predecessorJobId).digest('hex')}`;
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

async function markAccepted(
	redis: Redis,
	raw: string,
	receipt: DeferredHandoffReceipt
): Promise<boolean> {
	const accepted = JSON.stringify({ ...receipt, state: 'accepted', acceptedAt: Date.now() });
	return (
		((await redis.eval(
			"if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 end return 0",
			1,
			handoffKey(receipt.successorJobId),
			raw,
			accepted,
			String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
		)) as number) === 1
	);
}

/** Promote a successor before it can SMTP-send or complete. */
export async function promoteDeferredHandoff(redis: Redis, job: EmailJob): Promise<void> {
	if (!job.deferHandoffId) return;
	const raw = await redis.get(handoffKey(job.deferHandoffId));
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
	if (!(await markAccepted(redis, raw, receipt))) {
		const raced = parseReceipt(await redis.get(handoffKey(job.deferHandoffId)));
		if (raced?.state === 'accepted' && raced.messageId === job.messageId) return;
		throw new Error('Deferred handoff promotion lost its ownership');
	}
}

async function enqueueExactSuccessor(
	queue: Queue<EmailJob>,
	job: EmailJob,
	receipt: DeferredHandoffReceipt
): Promise<void> {
	await queue.add({
		groupId: receipt.groupId,
		data: { ...job, deferHandoffId: receipt.successorJobId },
		delay: receipt.delay,
		jobId: receipt.successorJobId,
	});
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
	const queued = await queue.getJob(successorJobId).catch(() => null);
	if (queued) {
		await markAccepted(redis, raw, receipt);
		return true;
	}
	await enqueueExactSuccessor(queue, job, receipt);
	await markAccepted(redis, raw, receipt);
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
	const successorJobId = deferredJobId(predecessorJobId);
	const key = handoffKey(successorJobId);
	const receipt: DeferredHandoffReceipt = {
		state: 'reserved',
		messageId: job.messageId,
		successorJobId,
		groupId,
		delay,
		reservedAt: Date.now(),
	};
	const reserved = await redis.set(
		key,
		JSON.stringify(receipt),
		'PX',
		GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		'NX'
	);
	if (reserved !== 'OK') {
		if (await resumeDeferredHandoff(redis, queue, predecessorJobId, job)) return;
		throw new Error('Deferred handoff reservation unavailable');
	}
	const raw = JSON.stringify(receipt);
	try {
		await enqueueExactSuccessor(queue, job, receipt);
		if (!(await markAccepted(redis, raw, receipt))) {
			const raced = parseReceipt(await redis.get(key));
			if (raced?.state !== 'accepted') throw new Error('Deferred handoff acceptance lost');
		}
	} catch (error) {
		const queued = await queue.getJob(successorJobId).catch(() => null);
		const promoted = parseReceipt(await redis.get(key));
		if (queued || promoted?.state === 'accepted') return;
		throw error;
	}
}
