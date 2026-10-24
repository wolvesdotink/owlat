/**
 * The wire shapes come from the public API contract, which the server
 * validates with; they are imported as types only, so the published bundle
 * carries no runtime dependency on it.
 */
export type {
	ApiErrorResponse,
	ApiResponse,
	JsonPrimitive,
	ListQuery as PaginationParams,
	PaginatedResponse,
	PaginationMeta,
} from '@owlat/public-contract';

/**
 * Rate limit information from API response headers.
 */
export interface RateLimitInfo {
	/**
	 * Maximum requests per second.
	 */
	limit: number;

	/**
	 * Remaining requests in current window.
	 */
	remaining: number;

	/**
	 * Unix timestamp when the rate limit resets.
	 */
	reset: number;
}

/**
 * Per-call options for the send methods (`transactional.send`, `events.send`).
 */
export interface RequestOptions {
	/**
	 * An idempotency key for this request, sent as the `Idempotency-Key`
	 * header: 1 to 255 printable ASCII characters without spaces, such as a
	 * UUID or your own order id. The server applies the request at most once per
	 * key for 24 hours and answers a repeat with the first response, so the SDK
	 * also retries a keyed send after a `5xx`, network error or timeout. Reusing
	 * a key for a different request fails with a `ConflictError` (409).
	 *
	 * Needs an Owlat server released after 0.6.16; an older server ignores the
	 * header, and a retried send could then go out twice.
	 */
	idempotencyKey?: string;
}
