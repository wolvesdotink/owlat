/**
 * Upload stages a test holds open and releases by hand, so a pipeline test can
 * await "n stages have started" instead of spinning until they have. A fake
 * stage calls `hold()`; the test awaits `started(n)`, inspects the pipeline,
 * then releases the held stages in the order it wants.
 */
export function heldStages() {
	const held: Array<() => void> = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	let started = 0;
	let inFlight = 0;
	let peak = 0;

	const wake = () => {
		for (const waiter of waiters.filter((w) => started >= w.count)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};

	return {
		/** The fake stage's body: counts the start, then blocks until released. */
		hold(): Promise<void> {
			started++;
			inFlight++;
			peak = Math.max(peak, inFlight);
			const released = new Promise<void>((resolve) =>
				held.push(() => {
					inFlight--;
					resolve();
				})
			);
			wake();
			return released;
		},
		/** Resolves once `count` stages have started in total (at once if they already have). */
		started(count: number): Promise<void> {
			return new Promise<void>((resolve) => {
				waiters.push({ count, resolve });
				wake();
			});
		},
		/** Releases every stage held right now, newest first; returns how many. */
		releaseNewestFirst(): number {
			const now = held.splice(0).reverse();
			for (const release of now) release();
			return now.length;
		},
		/** The most stages ever held at the same time. */
		get peak(): number {
			return peak;
		},
	};
}
