import type { ApiErrorReason, RateLimitInfo } from '../types/common';
import type { AbuseBlockedErrorData } from '../types/status';

/**
 * Base error class for all Owlat SDK errors.
 */
export class OwlatError extends Error {
	/**
	 * The Operation error category from the API (e.g., 'not_found',
	 * 'invalid_input', 'rate_limited'). For client-side faults that never reach
	 * the API this is a synthetic code ('timeout', 'network_error',
	 * 'parse_error', 'retry_exhausted'), for a response that did not come
	 * from the API it is 'unexpected_response', and for a dry run a server too
	 * old to know it answered with a queued send it is 'dry_run_unsupported'.
	 */
	readonly code: string;

	/**
	 * HTTP status code.
	 */
	readonly statusCode: number;

	/**
	 * Rate limit information from the response headers.
	 */
	readonly rateLimit?: RateLimitInfo;

	/**
	 * Operation error specifics carried alongside the category — e.g.
	 * `{ field }`, `{ limit, used }`, `{ retryAfter }`.
	 */
	readonly data?: Record<string, unknown>;

	/**
	 * Why the API refused the request, from `data.reason`: one of the
	 * {@link ApiErrorReason} codes, or a newer one this SDK does not know yet,
	 * which is best handled by its status. Undefined when the response named
	 * none.
	 */
	readonly reason?: ApiErrorReason | (string & {});

	constructor(
		message: string,
		code: string,
		statusCode: number,
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message);
		this.name = 'OwlatError';
		this.code = code;
		this.statusCode = statusCode;
		this.rateLimit = rateLimit;
		this.data = data;
		const reason = data?.['reason'];
		if (typeof reason === 'string') this.reason = reason;
	}
}

/**
 * Thrown when authentication fails (401 status).
 */
export class AuthenticationError extends OwlatError {
	constructor(
		message: string,
		code: string,
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 401, rateLimit, data);
		this.name = 'AuthenticationError';
	}
}

/**
 * Thrown when rate limit is exceeded (429 status).
 */
export class RateLimitError extends OwlatError {
	/**
	 * Number of seconds to wait before retrying. Read from `data.retryAfter`
	 * (or the `Retry-After` header) at the fetch boundary.
	 */
	readonly retryAfter: number;

	constructor(
		message: string,
		retryAfter: number,
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, 'rate_limited', 429, rateLimit, data);
		this.name = 'RateLimitError';
		this.retryAfter = retryAfter;
	}
}

/**
 * Thrown when a resource is not found (404 status).
 */
export class NotFoundError extends OwlatError {
	constructor(
		message: string,
		code: string = 'not_found',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 404, rateLimit, data);
		this.name = 'NotFoundError';
	}
}

/**
 * Thrown when request validation fails (400 status).
 */
export class ValidationError extends OwlatError {
	constructor(
		message: string,
		code: string,
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 400, rateLimit, data);
		this.name = 'ValidationError';
	}
}

/**
 * Thrown when there's a conflict (409 status).
 */
export class ConflictError extends OwlatError {
	constructor(
		message: string,
		code: string = 'conflict',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 409, rateLimit, data);
		this.name = 'ConflictError';
	}
}

/**
 * Thrown when the request is authenticated but not permitted (403 status).
 * Maps the `forbidden` Operation error category — e.g. a suspended or
 * abuse-blocked account.
 */
export class ForbiddenError extends OwlatError {
	/**
	 * Set when sending is suspended or banned (`reason: 'abuse_blocked'`): the
	 * status, since when, the recorded reason and how it lifts.
	 */
	readonly abuseBlocked?: AbuseBlockedErrorData;

	constructor(
		message: string,
		code: string = 'forbidden',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 403, rateLimit, data);
		this.name = 'ForbiddenError';
		// The server sends this shape with the reason; the SDK does not re-validate responses.
		if (this.reason === 'abuse_blocked')
			this.abuseBlocked = data as unknown as AbuseBlockedErrorData;
	}
}

/**
 * Thrown when the resource is in a state that disallows the operation
 * (422 status). Maps the `invalid_state` Operation error category — e.g. a
 * blocked recipient, an unpublished template, a template with no content, or
 * an unverified sending domain. This is the dominant transactional failure
 * mode, so catch it explicitly.
 */
export class InvalidStateError extends OwlatError {
	constructor(
		message: string,
		code: string = 'invalid_state',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 422, rateLimit, data);
		this.name = 'InvalidStateError';
	}
}

/**
 * Thrown when a plan or quota limit has been reached (402 status). Maps the
 * `limit_reached` Operation error category. Distinct from `RateLimitError`
 * (429), which is a transient per-second throttle.
 */
export class LimitReachedError extends OwlatError {
	constructor(
		message: string,
		code: string = 'limit_reached',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 402, rateLimit, data);
		this.name = 'LimitReachedError';
	}
}

/**
 * Thrown when a response is not the Owlat API's: an error status whose body is
 * not the `{ error: { category, message } }` envelope, or a 2xx body that is
 * not JSON. The usual cause is a `baseUrl` that points somewhere other than the
 * instance's API (the web app's address, a typo, a missing path prefix), or a
 * proxy in front of the instance answering for it. `url` leaves out the query
 * string and any credentials; neither field ever holds the API key.
 */
export class UnexpectedResponseError extends OwlatError {
	/** The URL that was called, without its query string. */
	readonly url: string;

	/** The start of the response body, whitespace collapsed. */
	readonly bodyExcerpt: string;

	constructor(statusCode: number, url: string, bodyExcerpt: string, rateLimit?: RateLimitInfo) {
		super(
			`Unexpected response from ${url} (HTTP ${statusCode}). This does not look like an Owlat API: check that baseUrl is your instance's API URL.${bodyExcerpt ? ` Body: ${bodyExcerpt}` : ''}`,
			'unexpected_response',
			statusCode,
			rateLimit
		);
		this.name = 'UnexpectedResponseError';
		this.url = url;
		this.bodyExcerpt = bodyExcerpt;
	}
}
