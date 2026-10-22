import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';

/** One minute at count zero, doubling per failed replay, capped at an hour. */
const WEBHOOK_DLQ_RETRY: RetryPolicy = { baseMs: 60_000, capMs: 60 * 60 * 1000 };

/** The one retry policy used by production and tests. */
export function webhookDlqRetryDelayMs(attempts: number): number {
	return nextDelay(WEBHOOK_DLQ_RETRY, attempts);
}
