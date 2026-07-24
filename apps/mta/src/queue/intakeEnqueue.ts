/** Reconciled intake for producers that do not have the HTTP /send receipt protocol. */

import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { EmailJob } from '../types.js';
import {
	intakeReceiptKey,
	parseIntakeReceipt,
	reserveNewIntakeReceipt,
} from '../routes/sendReceipt.js';

export interface ReconciledIntakeOptions {
	groupId: string;
	data: EmailJob & { intakeReceiptId: string };
	orderMs?: number;
	delay?: number;
}

export interface ReconciledIntakeQueue {
	add(options: {
		groupId: string;
		data: EmailJob;
		jobId?: string;
		orderMs?: number;
		delay?: number;
	}): Promise<unknown>;
	getJob(jobId: string): Promise<unknown | null>;
}

async function markAccepted(
	redis: Redis,
	intakeReceiptId: string,
	messageId: string
): Promise<void> {
	await redis.set(
		intakeReceiptKey(intakeReceiptId),
		JSON.stringify({ state: 'accepted', messageId, acceptedAt: Date.now() }),
		'PX',
		GOVERNED_MTA_MAX_MESSAGE_AGE_MS
	);
}

async function isCommitted(
	queue: ReconciledIntakeQueue,
	redis: Redis,
	intakeReceiptId: string,
	messageId: string
): Promise<boolean> {
	const receipt = parseIntakeReceipt(await redis.get(intakeReceiptKey(intakeReceiptId)));
	if (receipt?.messageId !== messageId) {
		throw new Error('Intake receipt identity is bound to another message');
	}
	if (receipt.state === 'accepted') return true;
	const queued = await queue.getJob(intakeReceiptId);
	if (!queued) return false;
	await markAccepted(redis, intakeReceiptId, messageId);
	return true;
}

/**
 * Enqueue one deterministic GroupMQ job and reconcile a lost add response.
 *
 * A reserved receipt without a visible job is safe to retry with the same
 * explicit job id. A visible or worker-accepted job is already committed and
 * must not be enqueued under a fresh identity.
 */
export async function enqueueReconciledIntake(
	queue: ReconciledIntakeQueue,
	redis: Redis,
	options: ReconciledIntakeOptions
): Promise<{ deduplicated: boolean }> {
	const { intakeReceiptId, messageId } = options.data;
	try {
		await reserveNewIntakeReceipt(redis, intakeReceiptId, messageId);
	} catch (error) {
		if (await isCommitted(queue, redis, intakeReceiptId, messageId)) {
			return { deduplicated: true };
		}
		const receipt = parseIntakeReceipt(await redis.get(intakeReceiptKey(intakeReceiptId)));
		if (receipt?.state !== 'reserved' || receipt.messageId !== messageId) throw error;
	}

	try {
		await queue.add({
			groupId: options.groupId,
			data: options.data,
			jobId: intakeReceiptId,
			...(options.orderMs === undefined ? {} : { orderMs: options.orderMs }),
			...(options.delay === undefined ? {} : { delay: options.delay }),
		});
		return { deduplicated: false };
	} catch (error) {
		if (await isCommitted(queue, redis, intakeReceiptId, messageId)) {
			return { deduplicated: true };
		}
		throw error;
	}
}
