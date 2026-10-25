/**
 * Run `task` over every item with at most `limit` in flight at once, and
 * resolve once all of them have settled. Items start in order; a task that
 * throws does not stop the others (its rejection is swallowed, so a task that
 * must report failure should resolve a value saying so).
 */
export async function runBounded<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<unknown>
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next]!;
			next += 1;
			try {
				await task(item);
			} catch {
				// Reported by the task itself; one failure never strands the rest.
			}
		}
	};
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
	await Promise.all(workers);
}
