/**
 * Map over a list with at most `limit` calls in flight.
 *
 * For fan-outs where running everything in series is too slow and running
 * everything at once is unsafe: each call holds its own request body in memory,
 * or the peer on the other end has a finite number of workers. Results come back
 * in INPUT order whatever order the calls finished in.
 *
 * `stopWhen` ends the run early: once a result satisfies it, no further item is
 * started. Calls already in flight still finish and keep their results; the
 * items never started are left `undefined` in the returned array.
 *
 * `fn` is expected to settle its own failures. If one rejects anyway, no further
 * item is started and the whole map rejects with that error once the calls
 * already in flight have settled.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	options: { stopWhen?: (result: R) => boolean } = {}
): Promise<Array<R | undefined>> {
	const results: Array<R | undefined> = Array.from({ length: items.length }, () => undefined);
	let next = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (!stopped && next < items.length) {
			const index = next++;
			try {
				const result = await fn(items[index] as T, index);
				results[index] = result;
				if (options.stopWhen?.(result)) stopped = true;
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	};
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const settled = await Promise.allSettled(Array.from({ length: workerCount }, worker));
	const failure = settled.find(
		(outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
	);
	if (failure) throw failure.reason;
	return results;
}
