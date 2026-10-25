/**
 * The per-IP connection slots a listener takes and gives back in Redis
 * (lib/connectionSlots.ts), as milestones a test can await. A slot is taken by
 * an EVAL that INCRs its key and given back by one that DECRs it; either one
 * completes after the listener's socket event that caused it, so a test that
 * awaits the count never has to poll the key.
 *
 * Install the watch before the action whose slots it counts.
 */

interface EvalRedis {
	eval(...args: never[]): Promise<unknown>;
}

export interface SlotWatch {
	/** Resolves once `count` slot acquisitions have completed since the watch began. */
	acquired(count: number): Promise<void>;
	/** Resolves once `count` slot releases have completed since the watch began. */
	released(count: number): Promise<void>;
}

/** Which slot operation an EVAL is, read from the script it runs. */
function slotOperation(script: unknown): 'acquire' | 'release' | null {
	const text = String(script);
	if (text.includes("'INCR'")) return 'acquire';
	if (text.includes("'DECR'")) return 'release';
	return null;
}

export function watchSlots(redis: EvalRedis): SlotWatch {
	const done = { acquire: 0, release: 0 };
	const waiters: Array<{ operation: 'acquire' | 'release'; count: number; resolve: () => void }> =
		[];
	const original = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	const settle = () => {
		for (const waiter of waiters.splice(0)) {
			if (done[waiter.operation] >= waiter.count) waiter.resolve();
			else waiters.push(waiter);
		}
	};
	(redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval = async (...args) => {
		const result = await original(...args);
		const operation = slotOperation(args[0]);
		if (operation) {
			done[operation] += 1;
			settle();
		}
		return result;
	};
	const reached = (operation: 'acquire' | 'release', count: number) =>
		new Promise<void>((resolve) => {
			waiters.push({ operation, count, resolve });
			settle();
		});
	return {
		acquired: (count) => reached('acquire', count),
		released: (count) => reached('release', count),
	};
}
