import type { RateLimitInfo, RequestOptions } from '../types/common';
import { OwlatError, ValidationError, UnexpectedResponseError } from '../errors';
import { bodyExcerpt, createError, displayUrl, errorEnvelope } from './errorResponse';

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
	/**
	 * Sent as the `Idempotency-Key` header. The server then applies the request
	 * at most once per key, which makes a POST safe to replay.
	 */
	idempotencyKey?: string;
}

/** Longest key the API accepts. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** The API's key rule: printable ASCII without spaces. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]+$/;

function assertIdempotencyKey(key: string): void {
	if (
		typeof key !== 'string' ||
		key.length === 0 ||
		key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
		!IDEMPOTENCY_KEY_PATTERN.test(key)
	) {
		throw new ValidationError(
			`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters without spaces`,
			'invalid_input'
		);
	}
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

/** Status codes that are safe to retry (transient server errors) */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Longest 429 `Retry-After` the client waits out before retrying. A longer one
 * (a send cap refilling in minutes, a daily cap resetting at midnight) is
 * thrown at once with its `retryAfter`: sleeping inside an awaited call such as
 * `transactional.send` would block the caller and, since the retry sleep is not
 * covered by the request timeout, could not end sooner than the server allows.
 * Mirrors the Java SDK's `MAX_RETRY_AFTER_MS = 30_000L`.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * HTTP methods safe to auto-retry on 5xx / network failure. Excludes `POST`:
 * a `POST /api/v1/transactional` or `/api/v1/events` the server processed but
 * whose response was lost (502/timeout) must NOT be replayed without an
 * idempotency key, since a retry would duplicate the send. GET, PUT and DELETE
 * are idempotent by HTTP semantics and safe to repeat.
 *
 * A 429 (rate-limited) is retryable regardless of method — it means the
 * request was rejected before processing, so replaying it cannot duplicate work.
 */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'PUT', 'DELETE']);

/**
 * Whether a repeat of the request cannot apply it twice: an idempotent method,
 * or a request carrying an `Idempotency-Key`, which the server answers from its
 * receipt instead of sending again.
 */
function isReplaySafe(options: FetchOptions): boolean {
	return IDEMPOTENT_METHODS.has(options.method) || options.idempotencyKey !== undefined;
}

/** Whether a failed request may be retried, given whether it is replay-safe. */
function isRetryable(replaySafe: boolean, status: number): boolean {
	if (!RETRYABLE_STATUS_CODES.has(status)) return false;
	// 429 is pre-processing rejection — safe to retry for any method.
	if (status === 429) return true;
	// 5xx may mean the server already applied the request; only replay one the
	// server cannot apply twice. A 409 (key reused for another request) is not
	// in the set and is never retried.
	return replaySafe;
}

/**
 * Read the response body, rejecting once `signal` aborts. Real fetch
 * implementations error the body stream when the request signal aborts, but
 * not every runtime (or polyfill, or mocked stream) does, so the race is made
 * explicit rather than trusted.
 *
 * The body is read through a reader this function owns, so a read cut off by
 * the deadline can also cancel the stream. Rejecting alone would leave a
 * runtime that ignores the abort holding the connection open for a body
 * nobody will read. (`response.text()` locks the stream, and a locked stream
 * cannot be cancelled from outside.)
 */
function readBodyBeforeDeadline(response: Response, signal: AbortSignal): Promise<string> {
	const body = response.body;
	if (!body) return raceText(response, signal);
	if (signal.aborted) {
		void body.cancel().catch(() => {});
		return Promise.reject(new BodyDeadlineError());
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => {
			reject(new BodyDeadlineError());
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener('abort', onAbort, { once: true });
		const done = () => signal.removeEventListener('abort', onAbort);
		const pump = (): void => {
			reader.read().then(
				({ done: finished, value }) => {
					if (finished) {
						done();
						resolve(text + decoder.decode());
						return;
					}
					text += decoder.decode(value, { stream: true });
					pump();
				},
				(error: unknown) => {
					done();
					reject(error);
				}
			);
		};
		pump();
	});
}

/** For a response object without a body stream: race `text()` against the deadline. */
function raceText(response: Response, signal: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => reject(new BodyDeadlineError());
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		response
			.text()
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/** Marker for a body read cut short by the request deadline. */
class BodyDeadlineError extends Error {
	constructor() {
		super('Response body not received before the deadline');
		this.name = 'AbortError';
	}
}

/**
 * Normalize a failure anywhere in the exchange (connect, headers or body) into
 * the SDK's `timeout` / `network_error` categories. The signal is the source of
 * truth for a timeout: a body stream torn down by the abort may surface as a
 * generic TypeError depending on the runtime.
 */
function transportError(error: unknown, signal: AbortSignal, timeout: number): OwlatError {
	if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
		return new OwlatError(`Request timed out after ${timeout}ms`, 'timeout', 0);
	}
	return new OwlatError(
		`Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
		'network_error',
		0
	);
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
	async function request<T>(path: string, options: FetchOptions): Promise<FetchResponse<T>> {
		const url = `${baseUrl}${path}`;
		const timeout = options.timeout ?? defaultTimeout;
		if (options.idempotencyKey !== undefined) assertIdempotencyKey(options.idempotencyKey);
		const replaySafe = isReplaySafe(options);
		// Serialized once: every attempt under one key must carry the same bytes,
		// or the server would see a different request and refuse it.
		const requestBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;

		let lastError: OwlatError | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const headers: Record<string, string> = {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			};
			if (options.idempotencyKey !== undefined) {
				headers['Idempotency-Key'] = options.idempotencyKey;
			}

			const fetchOptions: RequestInit = {
				method: options.method,
				headers,
				signal: controller.signal,
			};

			if (requestBody !== undefined) {
				fetchOptions.body = requestBody;
			}

			// The deadline covers the whole exchange: headers AND body. `fetch()`
			// resolves as soon as the headers arrive, so clearing the timer there
			// left a stalled body (slow proxy, half-dead connection) pending with no
			// bound at all. The body is read here, under the same timer, as text;
			// JSON parsing happens afterwards so a malformed body is still a
			// `parse_error` rather than a transport fault.
			let response: Response;
			let rawBody: string;
			try {
				response = await fetch(url, fetchOptions);
				rawBody = await readBodyBeforeDeadline(response, controller.signal);
			} catch (error) {
				lastError = transportError(error, controller.signal, timeout);
				// Retry on network errors and timeouts — but only when a replay
				// cannot apply the request twice. A POST that timed out may have
				// been processed server-side (a stalled body means it certainly
				// reached the server); without an idempotency key, replaying it
				// would duplicate the send.
				//
				// The status is not consulted here, on purpose: a GET whose
				// headers said 4xx but whose body then stalled is retried as a
				// timeout, although a 4xx with a body would not be. Without the
				// body there is no error envelope to act on, and repeating an
				// idempotent GET is harmless.
				if (attempt < maxRetries && replaySafe) {
					// oxlint-disable-next-line owlat/no-inline-backoff -- the published SDK cannot depend on the private @owlat/shared
					await sleep(initialDelayMs * Math.pow(backoffMultiplier, attempt));
					continue;
				}
				throw lastError;
			} finally {
				clearTimeout(timeoutId);
			}

			const rateLimit = extractRateLimit(response.headers);

			// Error responses (>=400) MUST be handled before the empty-body
			// success short-circuit below. A 4xx/5xx with an empty body (gateway
			// 502/503/504, edge 429, proxy 401) has no Content-Length or a
			// Content-Length of 0, so the old "empty response" branch returned it
			// as a null success — the resource layer then NPE'd, and the
			// retryable ones were never retried. Read the body as text and parse
			// the error envelope defensively: an empty body falls back to the
			// generic category/message, and a body that is not the envelope
			// becomes an UnexpectedResponseError.
			if (!response.ok) {
				const envelope = errorEnvelope(rawBody);
				const { message, category, data } = envelope ?? {
					message: 'Unknown error',
					category: 'internal',
					data: undefined,
				};
				const retryAfterHeader = response.headers.get('Retry-After');
				const retryAfterData =
					typeof data?.['retryAfter'] === 'number' ? data['retryAfter'] : undefined;
				const retryAfter =
					retryAfterData ?? (retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined);

				// A 429 stays a rate-limit error whoever sent it: proxies and edges
				// in front of an instance throttle too, and its Retry-After holds.
				lastError =
					envelope === null && response.status !== 429
						? new UnexpectedResponseError(
								response.status,
								displayUrl(url),
								bodyExcerpt(rawBody, apiKey),
								rateLimit
							)
						: createError(message, category, response.status, rateLimit, retryAfter, data);

				// A 429 asking for a longer wait than the client sleeps cannot be
				// outwaited by retrying: hand the caller its `retryAfter` at once.
				if (response.status === 429 && retryAfter && retryAfter * 1000 > MAX_RETRY_AFTER_MS) {
					throw lastError;
				}

				// Retry on transient errors (429 respects Retry-After, 5xx) — but
				// 5xx only for replay-safe requests, so a POST the server may have
				// already applied is never replayed without an idempotency key.
				if (isRetryable(replaySafe, response.status) && attempt < maxRetries) {
					const delay =
						response.status === 429 && retryAfter
							? retryAfter * 1000
							: // oxlint-disable-next-line owlat/no-inline-backoff -- the published SDK cannot depend on the private @owlat/shared
								initialDelayMs * Math.pow(backoffMultiplier, attempt);
					await sleep(delay);
					continue;
				}

				throw lastError;
			}

			// Empty success response (e.g., 204 No Content). Only reached once
			// we know the status is <400, so an empty error body can never slip
			// through here as a null "success".
			if (response.status === 204 || response.headers.get('content-length') === '0') {
				return {
					data: undefined as T,
					rateLimit,
				};
			}

			let body: unknown;
			try {
				body = JSON.parse(rawBody);
			} catch {
				// The API answers every 2xx with JSON; an HTML page here is most
				// often the web app's address given as baseUrl.
				throw new UnexpectedResponseError(
					response.status,
					displayUrl(url),
					bodyExcerpt(rawBody, apiKey),
					rateLimit
				);
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
		get: <T>(path: string, timeout?: number) => request<T>(path, { method: 'GET', timeout }),

		post: <T>(path: string, body?: unknown, timeout?: number, requestOptions?: RequestOptions) =>
			request<T>(path, {
				method: 'POST',
				body,
				timeout,
				...(requestOptions?.idempotencyKey !== undefined
					? { idempotencyKey: requestOptions.idempotencyKey }
					: {}),
			}),

		put: <T>(path: string, body?: unknown, timeout?: number) =>
			request<T>(path, { method: 'PUT', body, timeout }),

		delete: <T>(path: string, timeout?: number) => request<T>(path, { method: 'DELETE', timeout }),
	};
}

export type HttpClient = ReturnType<typeof createHttpClient>;
