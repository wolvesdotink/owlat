/**
 * Watches the per-IP connection limiter (`lib/connectionSlots.ts`) on a test's
 * Redis client. Every `eval` is delegated unchanged; once the script has
 * finished in Redis, the matching count goes up. `released(n)` resolves after
 * the n-th slot release has completed, so a test reads the counter once,
 * after the release it is about, instead of polling the key. A client socket's
 * close does not establish that: the server releases asynchronously after its
 * own side of the socket closes.
 */

import { vi } from 'vitest';

/** A count that only grows, whose milestones can be awaited before or after they happen. */
function milestones() {
	let count = 0;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	return {
		bump() {
			count += 1;
			for (const waiter of waiters.filter((w) => count >= w.n)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		},
		reached(n: number): Promise<void> {
			return new Promise<void>((resolve) => {
				if (count >= n) resolve();
				else waiters.push({ n, resolve });
			});
		},
	};
}

type Evaluating = { eval(...args: never[]): Promise<unknown> };

export function watchSlotScripts(redis: Evaluating): {
	/** Resolves once `n` acquire scripts (granted or refused) have completed. */
	acquired(n: number): Promise<void>;
	/** Resolves once `n` release scripts have completed. */
	released(n: number): Promise<void>;
} {
	const acquires = milestones();
	const releases = milestones();
	const evaluate = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	vi.spyOn(redis as { eval(...args: unknown[]): Promise<unknown> }, 'eval').mockImplementation(
		async (...args: unknown[]) => {
			const result = await evaluate(...args);
			const script = String(args[0]);
			if (script.includes("'INCR'")) acquires.bump();
			else if (script.includes("'DEL'")) releases.bump();
			return result;
		}
	);
	return { acquired: acquires.reached, released: releases.reached };
}
