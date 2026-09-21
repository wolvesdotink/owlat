/**
 * The single error vocabulary of the HTTP layer (plan §8.2).
 *
 * Handlers never format an error response themselves: they throw an
 * {@link HttpError}, and the one `onError` hook in `app.ts` turns it into the
 * `{ error }` body every route promises. That keeps the status/shape decision
 * in one place, and it means an error raised deep inside a parameter parser
 * cannot accidentally answer in a different format from one raised in a route.
 *
 * Nothing else is translated. In particular a `RangeError` is NOT a 400: the
 * log's coordinate arithmetic raises one for an out-of-range index or tree
 * size, but so does V8 for `Maximum call stack size exceeded` and
 * `Invalid string length`, and echoing one of those back would report a server
 * fault as a caller mistake and leak an engine string doing it. Coordinates are
 * therefore bounded against the log *before* the call (see `routes/log.ts`),
 * and a `RangeError` that still escapes is ours, not the caller's.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error whose status and message are safe to serve to an anonymous caller. */
export class HttpError extends Error {
	readonly status: ContentfulStatusCode;

	constructor(status: ContentfulStatusCode, message: string) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}

export function badRequest(message: string): HttpError {
	return new HttpError(400, message);
}

export function notFound(message: string): HttpError {
	return new HttpError(404, message);
}

export function payloadTooLarge(message: string): HttpError {
	return new HttpError(413, message);
}

export function unsupportedMediaType(message: string): HttpError {
	return new HttpError(415, message);
}

/**
 * A surface this node could serve but is not configured to. Used for the
 * leaf-hash form of the inclusion-proof endpoint when the composition root
 * wired no leaf-hash lookup: the caller's request is well formed, and telling
 * them so is more useful than a 400 that blames their spelling.
 */
export function notImplemented(message: string): HttpError {
	return new HttpError(501, message);
}

/** The body every failing route answers with. */
export interface ErrorBody {
	error: string;
}

/**
 * Status + body for any thrown value. Only {@link HttpError} describes a caller
 * mistake; anything else is ours, and its message stays in the process (the
 * caller gets `internal error`, the operator gets the log line the composition
 * root writes from `c.error`).
 */
export function toErrorResponse(err: unknown): { status: ContentfulStatusCode; body: ErrorBody } {
	if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
	return { status: 500, body: { error: 'internal error' } };
}
