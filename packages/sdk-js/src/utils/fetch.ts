import type { RateLimitInfo, ApiErrorResponse } from '../types/common';
import {
	OwlatError,
	AuthenticationError,
	RateLimitError,
	NotFoundError,
	ValidationError,
	ConflictError,
	ForbiddenError,
	InvalidStateError,
	LimitReachedError,
} from '../errors';

/**
 * HTTP method types supported by the client.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Options for making an HTTP request.
 */
export interface FetchOptions {
	method: HttpMethod;
	body?: unknown;
	timeout?: number;
}

/**
 * Response from the HTTP client.
 */
export interface FetchResponse<T> {
	data: T;
	rateLimit: RateLimitInfo;
}

/**
 * Extract rate limit info from response headers.
 */
function extractRateLimit(headers: Headers): RateLimitInfo {
	return {
		limit: parseInt(headers.get('X-RateLimit-Limit') || '10', 10),
		remaining: parseInt(headers.get('X-RateLimit-Remaining') || '10', 10),
		reset: parseInt(headers.get('X-RateLimit-Reset') || '0', 10),
	};
}

/**
 * Create an appropriate error based on status code. `code` is the Operation
 * error category from the response body; `data` carries its specifics.
 */
function createError(
	message: string,
	code: string,
	statusCode: number,
	rateLimit: RateLimitInfo,
	retryAfter?: number,
	data?: Record<string, unknown>
): OwlatError {
	switch (statusCode) {
		case 401:
			return new AuthenticationError(message, code, rateLimit, data);
		case 402:
			return new LimitReachedError(message, code, rateLimit, data);
		case 403:
			return new ForbiddenError(message, code, rateLimit, data);
		case 404:
			return new NotFoundError(message, code, rateLimit, data);
		case 409:
			return new ConflictError(message, code, rateLimit, data);
		case 422:
			return new InvalidStateError(message, code, rateLimit, data);
		case 429:
			return new RateLimitError(message, retryAfter || 1, rateLimit, data);
		case 400:
			return new ValidationError(message, code, rateLimit, data);
		default:
			return new OwlatError(message, code, statusCode, rateLimit, data);
	}
}

/** Status codes that are safe to retry (transient server errors) */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * HTTP methods safe to auto-retry on 5xx / network failure. Excludes `POST`:
 * a `POST /api/v1/transactional` or `/api/v1/events` the server processed but
 * whose response was lost (502/timeout) must NOT be replayed — there is no
 * server-side idempotency key, so a retry would duplicate the send. GET, PUT
 * and DELETE are idempotent by HTTP semantics and safe to repeat.
 *
 * A 429 (rate-limited) is always retryable regardless of method — it means the
 * request was rejected before processing, so replaying it cannot duplicate work.
 */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'PUT', 'DELETE']);

/** Whether a failed request may be retried for the given method + status. */
function isRetryable(method: HttpMethod, status: number): boolean {
	if (!RETRYABLE_STATUS_CODES.has(status)) return false;
	// 429 is pre-processing rejection — safe to retry for any method.
	if (status === 429) return true;
	// 5xx may mean the server already applied a non-idempotent POST; only
	// replay methods that are safe to repeat.
	return IDEMPOTENT_METHODS.has(method);
}

/** Configuration for automatic retry behavior */
export interface RetryConfig {
	/** Maximum number of retry attempts (default: 2, meaning 3 total attempts) */
	maxRetries?: number;
	/** Initial backoff delay in ms (default: 500) */
	initialDelayMs?: number;
	/** Backoff multiplier (default: 2) */
	backoffMultiplier?: number;
}

/**
 * HTTP client wrapper with timeout, authorization, retry, and error handling.
 */
export function createHttpClient(
	apiKey: string,
	baseUrl: string,
	defaultTimeout: number,
	retryConfig?: RetryConfig
) {
	const maxRetries = retryConfig?.maxRetries ?? 2;
	const initialDelayMs = retryConfig?.initialDelayMs ?? 500;
	const backoffMultiplier = retryConfig?.backoffMultiplier ?? 2;

	/**
	 * Sleep for a given duration (used for retry backoff).
	 */
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Make an HTTP request to the Owlat API with automatic retries.
	 */
	async function request<T>(
		path: string,
		options: FetchOptions
	): Promise<FetchResponse<T>> {
		const url = `${baseUrl}${path}`;
		const timeout = options.timeout ?? defaultTimeout;

		let lastError: OwlatError | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const headers: Record<string, string> = {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			};

			const fetchOptions: RequestInit = {
				method: options.method,
				headers,
				signal: controller.signal,
			};

			if (options.body !== undefined) {
				fetchOptions.body = JSON.stringify(options.body);
			}

			let response: Response;
			try {
				response = await fetch(url, fetchOptions);
			} catch (error) {
				clearTimeout(timeoutId);
				if (error instanceof Error && error.name === 'AbortError') {
					lastError = new OwlatError(
						`Request timed out after ${timeout}ms`,
						'timeout',
						0
					);
				} else {
					lastError = new OwlatError(
						`Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
						'network_error',
						0
					);
				}
				// Retry on network errors and timeouts — but only for idempotent
				// methods. A POST that timed out may have been processed
				// server-side; replaying it would duplicate the send.
				if (attempt < maxRetries && IDEMPOTENT_METHODS.has(options.method)) {
					await sleep(initialDelayMs * Math.pow(backoffMultiplier, attempt));
					continue;
				}
				throw lastError;
			} finally {
				clearTimeout(timeoutId);
			}

			const rateLimit = extractRateLimit(response.headers);

			// Handle empty response (e.g., 204 No Content)
			if (response.status === 204 || response.headers.get('content-length') === '0') {
				return {
					data: undefined as T,
					rateLimit,
				};
			}

			let body: unknown;
			try {
				body = await response.json();
			} catch {
				throw new OwlatError(
					'Failed to parse response body',
					'parse_error',
					response.status,
					rateLimit
				);
			}

			if (!response.ok) {
				const errorBody = body as ApiErrorResponse;
				const message = errorBody.error?.message || 'Unknown error';
				const category = errorBody.error?.category || 'internal';
				const data = errorBody.error?.data;
				const retryAfterHeader = response.headers.get('Retry-After');
				const retryAfterData =
					typeof data?.['retryAfter'] === 'number' ? data['retryAfter'] : undefined;
				const retryAfter =
					retryAfterData ??
					(retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined);

				lastError = createError(
					message,
					category,
					response.status,
					rateLimit,
					retryAfter,
					data
				);

				// Retry on transient errors (429 respects Retry-After, 5xx) — but
				// 5xx only for idempotent methods, so a non-idempotent POST the
				// server may have already applied is never replayed.
				if (isRetryable(options.method, response.status) && attempt < maxRetries) {
					const delay = response.status === 429 && retryAfter
						? retryAfter * 1000
						: initialDelayMs * Math.pow(backoffMultiplier, attempt);
					await sleep(delay);
					continue;
				}

				throw lastError;
			}

			// Defensive shape check before the unavoidable `as T`: a 2xx body
			// from this API is always a JSON object or array. A scalar/null here
			// means the contract drifted — surface it as a parse error instead of
			// handing back a mis-typed value the caller will dereference.
			if (typeof body !== 'object' || body === null) {
				throw new OwlatError(
					'Unexpected response shape (expected a JSON object)',
					'parse_error',
					response.status,
					rateLimit
				);
			}

			return {
				data: body as T,
				rateLimit,
			};
		}

		// Should not reach here, but satisfy TypeScript
		throw lastError ?? new OwlatError('Max retries exceeded', 'retry_exhausted', 0);
	}

	return {
		get: <T>(path: string, timeout?: number) =>
			request<T>(path, { method: 'GET', timeout }),

		post: <T>(path: string, body?: unknown, timeout?: number) =>
			request<T>(path, { method: 'POST', body, timeout }),

		put: <T>(path: string, body?: unknown, timeout?: number) =>
			request<T>(path, { method: 'PUT', body, timeout }),

		delete: <T>(path: string, timeout?: number) =>
			request<T>(path, { method: 'DELETE', timeout }),
	};
}

export type HttpClient = ReturnType<typeof createHttpClient>;
