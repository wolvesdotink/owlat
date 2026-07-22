/** Durable MTA intake receipts used to reconcile a lost POST /send response. */

import type { Context } from 'hono';
import type Redis from 'ioredis';
import type { AuthContext } from '../server.js';
import type { EmailJob } from '../types.js';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

export type IntakeReceipt =
	| { state: 'reserved'; messageId: string; reservedAt: number }
	| { state: 'accepted'; messageId: string; acceptedAt: number };

export const INTAKE_RESERVATION_LEASE_MS = 30_000;

export function intakeReceiptKey(workAttemptId: string): string {
	return `mta:work-attempts:${workAttemptId}`;
}

export function parseIntakeReceipt(value: string | null): IntakeReceipt | null {
	if (!value) return null;
	// A pre-receipt deployment wrote the literal `1` only after reservation.
	// Its deterministic GroupMQ job is checked by the caller before treating it
	// as accepted.
	if (value === '1') return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (
			typeof parsed['messageId'] === 'string' &&
			((parsed['state'] === 'reserved' && typeof parsed['reservedAt'] === 'number') ||
				(parsed['state'] === 'accepted' && typeof parsed['acceptedAt'] === 'number'))
		) {
			return parsed as IntakeReceipt;
		}
	} catch {
		// Malformed receipts are never positive acceptance evidence.
	}
	return null;
}

export async function hasAcceptedIntakeReceipt(
	redis: Redis,
	key: string,
	messageId: string
): Promise<boolean> {
	const receipt = parseIntakeReceipt(await redis.get(key));
	return receipt?.state === 'accepted' && receipt.messageId === messageId;
}

/**
 * A reserved GroupMQ job proves intake acceptance as soon as its worker starts.
 * The CAS prevents a colliding work attempt from overwriting another message's
 * receipt, and the write must succeed before any SMTP or terminal processing.
 */
export async function promoteIntakeReceipt(redis: Redis, job: EmailJob): Promise<void> {
	const key = intakeReceiptKey(job.intakeReceiptId);
	const raw = await redis.get(key);
	const receipt = parseIntakeReceipt(raw);
	if (receipt?.state === 'accepted' && receipt.messageId === job.messageId) return;
	if (!raw || receipt?.state !== 'reserved' || receipt.messageId !== job.messageId) {
		throw new Error('Work-attempt receipt is missing or bound to another message');
	}
	const accepted = JSON.stringify({
		state: 'accepted',
		messageId: job.messageId,
		acceptedAt: Date.now(),
	});
	const promoted = (await redis.eval(
		"if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 end return 0",
		1,
		key,
		raw,
		accepted,
		String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
	)) as number;
	if (promoted !== 1) {
		const raced = parseIntakeReceipt(await redis.get(key));
		if (raced?.state === 'accepted' && raced.messageId === job.messageId) return;
		throw new Error('Work-attempt receipt promotion lost its ownership');
	}
}

/** Reserve a receipt before a non-HTTP producer exposes its GroupMQ job. */
export async function reserveNewIntakeReceipt(
	redis: Redis,
	intakeReceiptId: string,
	messageId: string,
	now = Date.now()
): Promise<void> {
	const reserved = await redis.set(
		intakeReceiptKey(intakeReceiptId),
		JSON.stringify({ state: 'reserved', messageId, reservedAt: now }),
		'PX',
		GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		'NX'
	);
	if (reserved !== 'OK') {
		throw new Error('Intake receipt identity is already reserved');
	}
}

/** Authenticated durable acceptance lookup used after a lost intake response. */
export function createSendReceiptHandler(redis: Redis) {
	return async (c: Context) => {
		const auth = c.get('auth') as AuthContext;
		if (!auth.isMasterKey) return c.json({ error: 'Master credential required' }, 403);
		const workAttemptId = c.req.param('workAttemptId');
		if (!workAttemptId || workAttemptId.length > 128) {
			return c.json({ error: 'Invalid work attempt id' }, 400);
		}
		const receipt = parseIntakeReceipt(await redis.get(intakeReceiptKey(workAttemptId)));
		if (!receipt) return c.json({ state: 'absent' as const });
		if (receipt.state === 'reserved') return c.json({ state: 'pending' as const });
		return c.json(receipt);
	};
}
