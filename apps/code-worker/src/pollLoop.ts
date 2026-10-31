/**
 * The worker's poll loop and its stop switch. There is no listener to close:
 * the worker pulls work, so "stop accepting" means "do not start another
 * iteration". A step already running keeps running — cutting a task in half
 * would strand its branch and its Convex row, and the row is reclaimed at the
 * next boot anyway. Docker's grace period therefore still bounds a long task,
 * but the common case (a stop during the idle sleep, which is where the worker
 * spends nearly all of its time) ends the loop at once.
 */

export interface PollLoopSteps {
	pollCodeTasks(): Promise<void>;
	pollPluginTasks(): Promise<void>;
}

export interface PollLoop {
	/**
	 * Stop before the next step and cut an idle sleep short. Returns false when
	 * a stop was already requested.
	 */
	requestStop(): boolean;
	/** Drain both queues, then idle, until a stop is requested. */
	run(steps: PollLoopSteps, pollIntervalMs: number): Promise<void>;
}

export function createPollLoop(): PollLoop {
	// The stop arrives from a signal handler while `run` awaits, so it lives in
	// an AbortSignal that the idle sleep also listens to.
	const stop = new AbortController();
	const { signal } = stop;

	function sleepUntilNextPoll(pollIntervalMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', wake);
				resolve();
			};
			const timer = setTimeout(wake, pollIntervalMs);
			signal.addEventListener('abort', wake);
		});
	}

	return {
		requestStop() {
			if (signal.aborted) return false;
			stop.abort();
			return true;
		},
		async run(steps, pollIntervalMs) {
			while (!signal.aborted) {
				await steps.pollCodeTasks();
				if (signal.aborted) break;
				await steps.pollPluginTasks();
				if (signal.aborted) break;
				await sleepUntilNextPoll(pollIntervalMs);
			}
		},
	};
}
