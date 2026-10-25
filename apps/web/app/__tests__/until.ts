import { watch } from 'vue';

/**
 * Resolves once `ready()` holds. `ready` reads reactive state, so this waits
 * for the change itself: no polling, no counting microtasks.
 */
export function until(ready: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const stop = watch(
			ready,
			(value) => {
				if (!value || done) return;
				done = true;
				resolve();
				queueMicrotask(() => stop());
			},
			{ immediate: true, flush: 'sync' }
		);
		if (done) stop();
	});
}
