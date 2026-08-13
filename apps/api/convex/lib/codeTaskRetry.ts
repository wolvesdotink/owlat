/**
 * Retry policy for code-work tasks (the code-worker queue).
 *
 * A code task run is expensive and long — a clone, a coding agent with a
 * 10-minute budget, then the test suite — and most of its failure modes are
 * transient (LLM endpoint hiccup, a network blip, a crashed/restarted worker),
 * so a failed attempt is requeued behind a growing delay instead of dying on
 * the first stumble. The schedule lives here, apart from the mutation module,
 * so it can be unit-tested on its own and so both the failure path and the
 * startup reclaim sweep decide identically.
 */

/** Total attempts a task gets, including the first one. */
export const CODE_TASK_MAX_ATTEMPTS = 3;

/**
 * Delay before the attempt that follows each failure, indexed by attempts
 * already made (1st failure -> 1m, 2nd -> 5m). Deliberately far longer than the
 * generic worker-loop schedule in `constants.ts`: a retry re-runs the whole
 * expensive pipeline, so a hard-down LLM endpoint must not be hammered. The
 * last entry applies to any further attempt a raised `maxAttempts` allows.
 */
export const CODE_TASK_RETRY_DELAYS_MS = [60_000, 300_000] as const;

export function codeTaskRetryDelayMs(attempts: number): number {
	const index = Math.min(Math.max(attempts, 1), CODE_TASK_RETRY_DELAYS_MS.length) - 1;
	return CODE_TASK_RETRY_DELAYS_MS[index]!;
}

export type CodeTaskRetryDecision =
	| { retry: true; attempts: number; nextAttemptAt: number }
	| { retry: false; attempts: number };

/**
 * Decide what happens to a task that just failed: requeue it behind a backoff
 * window, or give up. `attempts` is the number of claims made so far (the
 * failing one included), so the ceiling is reached once it equals the row's
 * `maxAttempts`.
 */
export function codeTaskRetryDecision(
	task: { attempts?: number; maxAttempts?: number },
	now: number
): CodeTaskRetryDecision {
	const attempts = task.attempts ?? 0;
	const maxAttempts = task.maxAttempts ?? CODE_TASK_MAX_ATTEMPTS;
	if (attempts >= maxAttempts) {
		return { retry: false, attempts };
	}
	return { retry: true, attempts, nextAttemptAt: now + codeTaskRetryDelayMs(attempts) };
}
