/**
 * Configuration options for the Owlat SDK client.
 */
export interface OwlatConfig {
	/**
	 * Your Owlat API key. Must start with "lm_live_".
	 */
	apiKey: string;

	/**
	 * Base URL for the Owlat API. Defaults to "https://api.owlat.app".
	 */
	baseUrl?: string;

	/**
	 * Request timeout in milliseconds. Defaults to 30000 (30 seconds).
	 */
	timeout?: number;

	/**
	 * Automatic retry configuration for transient failures, with exponential
	 * backoff. A 429 is always retried (it respects `Retry-After`). A 5xx or
	 * network/timeout failure is retried for idempotent methods (GET/PUT/DELETE)
	 * and for a `POST` send (`transactional.send`, `events.send`) called with an
	 * `idempotencyKey`, which the server applies at most once. A send without a
	 * key is never replayed after a 5xx or network failure, since a retry could
	 * duplicate it. Set to `false` to disable retries entirely. Defaults to 2
	 * retries.
	 */
	retry?:
		| {
				/** Maximum retry attempts (default: 2, meaning 3 total attempts) */
				maxRetries?: number;
				/** Initial backoff delay in ms (default: 500) */
				initialDelayMs?: number;
				/** Backoff multiplier (default: 2) */
				backoffMultiplier?: number;
		  }
		| false;
}
