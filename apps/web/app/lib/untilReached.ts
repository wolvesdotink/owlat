import { watch, type WatchSource } from 'vue';

/**
 * Resolve once `reached()` holds, re-checking whenever `source` changes, or
 * after `timeoutMs` at the latest (it never rejects). For waiting, briefly, on
 * a live query to deliver a row a mutation already told the caller about.
 */
export function untilReached(
	source: WatchSource<unknown>,
	reached: () => boolean,
	timeoutMs: number
): Promise<void> {
	return new Promise<void>((resolve) => {
		if (reached()) {
			resolve();
			return;
		}
		const stop = watch(source, () => {
			if (reached()) finish();
		});
		const timer = setTimeout(() => finish(), timeoutMs);
		const finish = () => {
			clearTimeout(timer);
			stop();
			resolve();
		};
	});
}
