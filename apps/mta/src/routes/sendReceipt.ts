/** Durable MTA intake receipts used to reconcile a lost POST /send response. */

import type { Context } from 'hono';
import type Redis from 'ioredis';
import type { AuthContext } from '../server.js';

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
