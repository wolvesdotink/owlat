/**
 * A defer costs no delivery attempt, so `maxAttempts` cannot stop a retry
 * ladder and the max-message-age cap only stops it in time. The successor
 * budget is what stops it in count — the invariant that makes one message
 * minting six million queue entries impossible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import {
	claimDeferSuccessor,
	deferBudgetKey,
	MAX_DEFER_SUCCESSORS_PER_MESSAGE,
} from '../deferBudget.js';

describe('defer successor budget', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
	});

	/** Spend all but `remaining` of a message's budget without the round trips. */
	async function seedSpent(messageId: string, spent: number) {
		await redis.set(deferBudgetKey(messageId), String(spent));
	}

	it('counts every successor a message asks for', async () => {
		expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual({
			granted: true,
			spent: 1,
		});
		expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual({
			granted: true,
			spent: 2,
		});
	});

	it('counts each message separately', async () => {
		await claimDeferSuccessor(redis as never, 'msg-1');
		expect(await claimDeferSuccessor(redis as never, 'msg-2')).toEqual({
			granted: true,
			spent: 1,
		});
	});

	it('refuses once the budget is spent, and stays refused', async () => {
		await seedSpent('msg-1', MAX_DEFER_SUCCESSORS_PER_MESSAGE - 1);

		expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual({
			granted: true,
			spent: MAX_DEFER_SUCCESSORS_PER_MESSAGE,
		});
		expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual({
			granted: false,
			spent: MAX_DEFER_SUCCESSORS_PER_MESSAGE + 1,
		});
		expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual({
			granted: false,
			spent: MAX_DEFER_SUCCESSORS_PER_MESSAGE + 2,
		});
	});

	it('shares one budget across every chain of the same message', async () => {
		// Each governed /send carries its own workAttemptId, which becomes the
		// job id and seeds an independent defer chain. A per-chain cap would let
		// N roots mint N caps between them; the counter is keyed by message.
		await seedSpent('msg-1', MAX_DEFER_SUCCESSORS_PER_MESSAGE);

		const fromAnotherRoot = await claimDeferSuccessor(redis as never, 'msg-1');

		expect(fromAnotherRoot.granted).toBe(false);
	});

	it('bounds the counter to the message lifetime so it cannot leak', async () => {
		await claimDeferSuccessor(redis as never, 'msg-1');
		const ttl = await redis.pttl(deferBudgetKey('msg-1'));

		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(GOVERNED_MTA_MAX_MESSAGE_AGE_MS);

		// Refreshed on every rung, so a live ladder never loses its count
		// mid-flight and an abandoned one still expires.
		await claimDeferSuccessor(redis as never, 'msg-1');
		expect(await redis.pttl(deferBudgetKey('msg-1'))).toBeGreaterThan(0);
	});

	it('allows any ladder a message could honestly need', async () => {
		// Four days of one-per-minute retries: longer than the max message age,
		// so the budget can only bite a ladder that is outrunning its delays.
		expect(MAX_DEFER_SUCCESSORS_PER_MESSAGE).toBe(
			Math.ceil(GOVERNED_MTA_MAX_MESSAGE_AGE_MS / 60_000)
		);
	});
});
