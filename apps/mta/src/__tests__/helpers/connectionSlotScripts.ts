/**
 * Awaitable milestones for the per-IP connection slots (lib/connectionSlots.ts).
 *
 * The listener acquires and releases a peer's slot from socket events, out of
 * the test's reach, so a test cannot await the call itself. Spying on the
 * client's `eval` sees each slot script finish instead: a test awaits the n-th
 * acquire or release rather than polling the counter key.
 */

import { vi } from 'vitest';

/** A fragment unique to each slot script in lib/connectionSlots.ts. */
const ACQUIRE_MARKER = "local count = redis.call('INCR', KEYS[1])";
const RELEASE_MARKER = "if redis.call('DECR', KEYS[1]) <= 0";

type EvalClient = { eval: (...args: unknown[]) => Promise<unknown> };

function milestoneCounter() {
	let count = 0;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	return {
		hit(): void {
			count += 1;
			for (const waiter of waiters.filter((w) => w.n <= count)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		},
		reached(n: number): Promise<void> {
			if (count >= n) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ n, resolve }));
		},
	};
}

/**
 * Watch the slot scripts run against `redis` (a mock or real client). Each
 * promise resolves once that many acquires (granted or refused) or releases
 * have finished.
 */
export function watchSlotScripts(redis: object): {
	acquired(n: number): Promise<void>;
	released(n: number): Promise<void>;
} {
	const client = redis as EvalClient;
	const acquires = milestoneCounter();
	const releases = milestoneCounter();
	const originalEval = client.eval.bind(client);
	vi.spyOn(client, 'eval').mockImplementation(async (...args: unknown[]) => {
		const result = await originalEval(...args);
		const script = String(args[0]);
		if (script.includes(ACQUIRE_MARKER)) acquires.hit();
		if (script.includes(RELEASE_MARKER)) releases.hit();
		return result;
	});
	return { acquired: acquires.reached, released: releases.reached };
}
