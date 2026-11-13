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
import { reduce, type DispatchOutcome } from '../../dispatch/outcome.js';
import { classifySmtpResponse } from '../../intelligence/smtpClassifier.js';
import type { AttemptCtx } from '../../dispatch/types.js';

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
	});

	it('reports the same count to every replay of an already-refused job', async () => {
		// `spent` is quoted in the terminal Convex callback, whose outbox row is
		// protected: a replay rebuilds the payload and it is compared
		// byte-for-byte. A counter that kept climbing made the rebuild differ
		// every time, so the replay threw and the job dead-lettered on a
		// give-up that had already been decided correctly.
		await seedSpent('msg-1', MAX_DEFER_SUCCESSORS_PER_MESSAGE);

		const refused = await claimDeferSuccessor(redis as never, 'msg-1');
		expect(refused.granted).toBe(false);
		for (let replay = 0; replay < 3; replay++) {
			expect(await claimDeferSuccessor(redis as never, 'msg-1')).toEqual(refused);
		}
		expect(await redis.get(deferBudgetKey('msg-1'))).toBe(
			String(MAX_DEFER_SUCCESSORS_PER_MESSAGE + 1)
		);
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

	it('retries a message the receiver keeps deferring across its whole lifetime', () => {
		// The receiver answers every attempt with a generic 451. The successor
		// carries the deferral count, so walk the ladder the reducer asks for at the
		// shortest jitter (-15%) the handler can apply, until the message expires.
		const outcome: DispatchOutcome = {
			kind: 'deferred',
			smtpCode: 451,
			error: '451 4.3.0 Temporary local problem',
			enhancedCode: undefined,
			classification: classifySmtpResponse(451, '451 4.3.0 Temporary local problem', undefined),
		};
		const ctxAfter = (remoteDeferrals: number) =>
			({
				job: { messageId: 'msg-1', remoteDeferrals },
				destination: { throttleKey: 'example.com', providerKey: 'other' },
				ip: '192.0.2.1',
				domain: 'example.com',
				providerVolumePressure: 0,
				utcDate: '2026-03-01',
			}) as unknown as AttemptCtx;

		let elapsed = 0;
		let rungs = 0;
		let longestWait = 0;
		while (elapsed < GOVERNED_MTA_MAX_MESSAGE_AGE_MS) {
			const delay = reduce(outcome, ctxAfter(rungs)).defer!.delayMs;
			longestWait = Math.max(longestWait, delay);
			elapsed += delay * 0.85;
			rungs++;
		}

		// Never refused as a runaway before it expires, with room left in the
		// budget for the self-throttle rungs that share it...
		expect(rungs).toBeLessThan(MAX_DEFER_SUCCESSORS_PER_MESSAGE / 10);
		// ...and still retried at least hourly to the end.
		expect(longestWait).toBeLessThanOrEqual(3_600_000);
		expect(rungs).toBeGreaterThan(GOVERNED_MTA_MAX_MESSAGE_AGE_MS / 3_600_000);
	});

	it('allows a rung a minute for the whole message lifetime', async () => {
		// The cap is sized off a one-per-minute pace, not off the shortest defer
		// the MTA can issue (a flat 5s when a domain slot is contended). See
		// deferBudget.ts for why that trade is deliberate.
		expect(MAX_DEFER_SUCCESSORS_PER_MESSAGE).toBe(
			Math.ceil(GOVERNED_MTA_MAX_MESSAGE_AGE_MS / 60_000)
		);
	});
});
