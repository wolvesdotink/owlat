import type { RateLimitInfo } from '../types/common';

/**
 * Base error class for all Owlat SDK errors.
 */
export class OwlatError extends Error {
	/**
	 * The Operation error category from the API (e.g., 'not_found',
	 * 'invalid_input', 'rate_limited'). For client-side faults that never reach
	 * the API this is a synthetic code ('timeout', 'network_error',
	 * 'parse_error', 'retry_exhausted').
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

		// Maintains proper stack trace for where error was thrown
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, OwlatError);
		}
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
	constructor(
		message: string,
		code: string = 'forbidden',
		rateLimit?: RateLimitInfo,
		data?: Record<string, unknown>
	) {
		super(message, code, 403, rateLimit, data);
		this.name = 'ForbiddenError';
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
