import { vi } from 'vitest';

/**
 * Run a dispatch whose provider fails transiently, with the dispatcher's
 * backoff between attempts on fake timers.
 *
 * `withLlmRetry` sleeps for real between attempts (half a second and up), so
 * on the real clock a three-attempt case waits seconds for nothing. Here
 * `setTimeout` is faked for the dispatch only and every backoff timer it arms
 * is run, so the retry sequence, its attempt count and the delay it chose all
 * stay those of production, at no wall-clock cost. Only the timer functions
 * are faked: the dates a dispatch records keep reading the real clock.
 *
 * Each scripted provider failure must settle within microtasks (a mocked
 * rejection, a mock model), as every caller's does: the timers are run until
 * none is left, and a failure still pending on real I/O then would leave its
 * backoff unrun.
 */
export async function withFakeBackoff<T>(dispatch: () => Promise<T>): Promise<T> {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	try {
		const result = dispatch();
		// The caller awaits the rejection; this keeps it from being reported as
		// unhandled while the timers run.
		result.catch(() => undefined);
		await vi.runAllTimersAsync();
		return await result;
	} finally {
		vi.useRealTimers();
	}
}
