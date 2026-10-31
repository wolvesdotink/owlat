/**
 * Automatic recovery for query subscriptions that fail for a reason that is
 * likely to pass on its own.
 *
 * A Convex query that throws stays failed until the server pushes a new result,
 * and on a quiet install nothing ever does. The typical case is a cold,
 * small deployment where a page opens ten subscriptions at once and a few of
 * them hit "Function execution timed out": the page stayed broken until a
 * reload. `useConvexQuery` and `usePaginatedQuery` use this module to drop the
 * failed subscription and open it again, a bounded number of times, with
 * backoff.
 *
 * Pure apart from the timer it owns, so the policy is unit-testable on its own.
 */
import { ConvexError } from 'convex/values';
import { extractOperationError } from '@owlat/shared/operationError';
import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';

/** How many times a transient failure is retried before it is shown. */
export const TRANSIENT_RETRY_LIMIT = 3;

const TRANSIENT_RETRY: RetryPolicy = {
	baseMs: 1_000,
	capMs: 8_000,
	jitter: { kind: 'spread', ratio: 0.2 },
	round: true,
};

/**
 * Failures that are the request's own fault. Retrying them gives the same
 * answer, so they surface straight away.
 */
const PERMANENT_MESSAGE =
	/ArgumentValidationError|ReturnsValidationError|Could not find public function/i;

/**
 * Whether a query failure is worth retrying.
 *
 * A `ConvexError` is a decision the backend made on purpose: a permission
 * refusal, a disabled feature, a missing record (the operation error categories). Those
 * are final. Anything else is an uncaught server error: a function timeout, an
 * overloaded deployment, or (in production, where Convex redacts the message to
 * "Server Error") something we cannot tell apart from those. Retrying a genuine
 * bug a few times costs three extra reads; not retrying a timeout leaves the
 * page broken until a reload.
 */
export function isTransientQueryError(error: unknown): boolean {
	if (error instanceof ConvexError) return false;
	if (extractOperationError(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return !PERMANENT_MESSAGE.test(message);
}

/**
 * Delay before retry number `attempt` (0-based): 1s, 2s, 4s, capped at 8s, each
 * spread by up to ±20% so the queries of one page do not all return to a
 * struggling deployment in the same instant.
 */
export function transientRetryDelay(attempt: number, random: () => number = Math.random): number {
	return nextDelay(TRANSIENT_RETRY, attempt, undefined, random);
}

export interface TransientRetry {
	/**
	 * Schedule `resubscribe` if `error` is transient and the budget is not spent.
	 * Returns false when the caller should surface the error instead.
	 */
	schedule: (error: unknown, resubscribe: () => void) => boolean;
	/** Restore the full budget: after a result arrives, or new args / a manual refetch. */
	reset: () => void;
	/** Drop a pending retry (the subscription was replaced or disposed). */
	cancel: () => void;
}

export function createTransientRetry(limit: number = TRANSIENT_RETRY_LIMIT): TransientRetry {
	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	return {
		schedule(error, resubscribe) {
			if (attempts >= limit || !isTransientQueryError(error)) return false;
			cancel();
			const delay = transientRetryDelay(attempts);
			attempts += 1;
			timer = setTimeout(() => {
				timer = null;
				resubscribe();
			}, delay);
			return true;
		},
		reset() {
			attempts = 0;
		},
		cancel,
	};
}
