const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** The one retry policy used by production and tests. */
export function webhookDlqRetryDelayMs(attempts: number): number {
	return Math.min(60_000 * 2 ** Math.max(0, attempts), MAX_RETRY_DELAY_MS);
}
