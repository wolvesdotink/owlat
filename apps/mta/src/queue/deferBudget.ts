/**
 * How much queue a single message is allowed to mint.
 *
 * A defer never consumes a delivery attempt — the handler re-enqueues a
 * successor with the computed delay and completes — so `maxAttempts` does not
 * bound a retry ladder. The only bound is the max message age, which stops the
 * ladder in TIME but says nothing about how many rungs it may take to get
 * there. When something made the ladder advance far faster than its delays, a
 * single "Owlat delivery test" minted six million queue entries and 3.9 GB of
 * Redis before the kernel OOM-killed it.
 *
 * So bound the ladder in COUNT as well. The budget is keyed by messageId
 * rather than by defer chain deliberately: a message can have several roots —
 * every governed `/send` carries its own `workAttemptId`, which becomes the
 * job id and seeds an independent chain — and a per-chain cap would let N
 * roots mint N caps' worth between them. One counter per message sees all of
 * them.
 */

import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

/**
 * The shortest delay a defer ladder sustains in practice. Individual defers go
 * as low as 5s (a contended connection slot), but every ladder that can repeat
 * for days — greylisting, rate limiting, warming caps — is measured in minutes.
 */
const SUSTAINED_DEFER_INTERVAL_MS = 60_000;

/**
 * The most successors one message may mint: as many rungs as a one-per-minute
 * ladder could take before the message expires anyway. Reaching it means the
 * ladder is advancing faster than any delay it asked for, which is a runaway,
 * not a retry.
 */
export const MAX_DEFER_SUCCESSORS_PER_MESSAGE = Math.ceil(
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS / SUSTAINED_DEFER_INTERVAL_MS
);

export function deferBudgetKey(messageId: string): string {
	return `mta:defer-budget:${messageId}`;
}

export interface DeferBudgetClaim {
	/** False once the message has spent its budget: mint nothing further. */
	granted: boolean;
	/** Successors this message has now asked for, including this one. */
	spent: number;
}

/**
 * Count one successor against the message's budget.
 *
 * INCR and PEXPIRE go in one EVAL so the counter can never outlive its refresh
 * — a crash between two commands would otherwise strand an immortal key, which
 * is the class of bug this whole guard exists to prevent. EVAL sends the body,
 * so unlike EVALSHA it cannot fail against a restarted server's empty script
 * cache; a guard that breaks when Redis restarts would be no guard at all.
 */
export async function claimDeferSuccessor(
	redis: Redis,
	messageId: string
): Promise<DeferBudgetClaim> {
	const spent = (await redis.eval(
		"local n = redis.call('INCR', KEYS[1]) redis.call('PEXPIRE', KEYS[1], ARGV[1]) return n",
		1,
		deferBudgetKey(messageId),
		String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
	)) as number;

	return { granted: spent <= MAX_DEFER_SUCCESSORS_PER_MESSAGE, spent };
}
