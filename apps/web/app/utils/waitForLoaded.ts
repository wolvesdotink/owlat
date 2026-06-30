import type { Ref, WatchSource } from 'vue';

/**
 * Returns a promise that resolves once the given reactive source becomes
 * falsy (for loading refs) or satisfies a custom predicate.
 *
 * Commonly used to wait for async state in middleware before navigating.
 *
 * @param source   A ref or getter whose value signals "still loading"
 * @param isDone   Optional predicate — defaults to `(v) => !v` (falsy = done)
 * @param timeoutMs Safety timeout to avoid hanging forever (default 5 000 ms)
 */
export function waitForLoaded(
	source: WatchSource<unknown>,
	isDone: (value: unknown) => boolean = (v) => !v,
	timeoutMs = 5_000,
): Promise<void> {
	// Evaluate current value immediately
	const current = typeof source === 'function' ? source() : (source as Ref).value;
	if (isDone(current)) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const timeoutId = setTimeout(() => {
			stop();
			resolve();
		}, timeoutMs);

		const stop = watch(source, (val) => {
			if (isDone(val)) {
				clearTimeout(timeoutId);
				stop();
				resolve();
			}
		}, { immediate: true });
	});
}
