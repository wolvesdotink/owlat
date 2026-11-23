/**
 * Turning an error response into the SDK's error: the typed error for the API's
 * envelope, and what an error may show of a response that is not the API's.
 */
import type { RateLimitInfo } from '../types/common';
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
 * Create an appropriate error based on status code. `code` is the Operation
 * error category from the response body; `data` carries its specifics.
 */
export function createError(
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

/**
 * The parts of an error body's `{ error: { message, category, data } }`
 * envelope that are usable: a field that is missing, empty or of the wrong
 * type takes the generic fallback, as an empty body does. A body that is there
 * but is not that envelope returns null: the API wraps every failure of its
 * own in it, so such a body came from something else (a wrong host or path,
 * a proxy).
 */
export function errorEnvelope(rawBody: string): {
	message: string;
	category: string;
	data: Record<string, unknown> | undefined;
} | null {
	let fields: Record<string, unknown> = {};
	if (rawBody) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			return null;
		}
		const error = isObject(parsed) ? parsed['error'] : undefined;
		if (!isObject(error)) return null;
		fields = error;
	}
	const message = fields['message'];
	const category = fields['category'];
	const data = fields['data'];
	return {
		message: typeof message === 'string' && message ? message : 'Unknown error',
		category: typeof category === 'string' && category ? category : 'internal',
		data: isObject(data) ? data : undefined,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Longest stretch of a foreign response body an error carries. */
const BODY_EXCERPT_LENGTH = 200;

/**
 * The start of a response body, on one line, for an error message. A server
 * that echoes the request could put the API key in its body, so the key is
 * cut out before anything is kept.
 */
export function bodyExcerpt(rawBody: string, apiKey: string): string {
	let text = rawBody.replace(/\s+/g, ' ').trim();
	if (apiKey) text = text.split(apiKey).join('[redacted]');
	return text.length > BODY_EXCERPT_LENGTH ? `${text.slice(0, BODY_EXCERPT_LENGTH - 1)}…` : text;
}

/**
 * The called URL as an error may show it: without credentials in the
 * authority, and without the query string, which can hold a contact's email.
 */
export function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		parsed.search = '';
		parsed.hash = '';
		return parsed.toString();
	} catch {
		return url.split(/[?#]/)[0] ?? url;
	}
}
