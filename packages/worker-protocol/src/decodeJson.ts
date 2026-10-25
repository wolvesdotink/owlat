/**
 * Decode an untrusted JSON request body at the transport, before any handler
 * code reads a field of it.
 *
 * A type argument (`req.json<T>()`) or a cast (`JSON.parse(text) as T`) is not
 * a check: a producer that sends `"to": 42` gets its number all the way into
 * the business code, where it surfaces as a TypeError (a 500) or worse, as a
 * value stored under the wrong type. Here the body is read under a byte cap,
 * parsed to `unknown`, and handed to a decoder; the handler only ever sees a
 * value that passed it, or a client error it can answer with.
 *
 * Every transport (Hono, Nitro, a bare Node server, a Convex HTTP action) keeps
 * its own thin adapter for the parts that differ: how to get a body stream and
 * how to answer a refusal. The read, the parse and the check live here once.
 *
 * Runtime imports: only the bounded reader from `@owlat/shared/cappedStream`.
 * `convex/values` and `node:http` are imported for types alone, so a consumer
 * that checks with a plain guard needs no Convex runtime, and the module runs
 * in Convex's isolate as well as in Node.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { GenericValidator, Infer } from 'convex/values';
import { readStreamPrefix } from '@owlat/shared/cappedStream';
import { validatorMismatch, type UnknownKeys } from './validatorMatch';

/** A decoder's verdict on one parsed value. */
export type Decoded<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issue: string };

/**
 * Checks a parsed JSON value and narrows it to `T`.
 *
 * An `issue` ends up in a client error and in logs, so a decoder must describe
 * WHERE the value failed and never echo what it found there: a request body
 * can carry credentials.
 */
export type JsonDecoder<T> = (value: unknown) => Decoded<T>;

/**
 * A decoder from a Convex validator.
 *
 * Unknown keys are IGNORED by default, unlike Convex's own exact objects: a
 * request schema is read by a consumer, and a producer one release ahead may
 * already send a field this build has never heard of (an additive change is a
 * compatible one). Refusing the whole request for it would break every rolling
 * deploy. A route whose protocol is deliberately exact passes `'reject'`. The
 * value is returned as parsed, unknown keys included, never as a stripped copy.
 */
export function validatorDecoder<V extends GenericValidator>(
	validator: V,
	unknownKeys: UnknownKeys = 'ignore'
): JsonDecoder<Infer<V>> {
	return (value) => {
		const issue = validatorMismatch(validator, value, { unknownKeys });
		return issue === null ? { ok: true, value: value as Infer<V> } : { ok: false, issue };
	};
}

/**
 * A decoder from a type guard a route already owns (a protocol package's
 * `isX`, a hand-written exact-key check). `issue` is the fixed description
 * reported when the guard refuses.
 */
export function guardDecoder<T>(
	guard: (value: unknown) => value is T,
	issue = '$: does not match the request schema'
): JsonDecoder<T> {
	return (value) => (guard(value) ? { ok: true, value } : { ok: false, issue });
}

/**
 * A decoder from a parse function that answers the checked value, or `null`
 * (or `undefined`) when the input is not one.
 */
export function parserDecoder<T>(
	parse: (value: unknown) => T | null | undefined,
	issue = '$: does not match the request schema'
): JsonDecoder<T> {
	return (value) => {
		const parsed = parse(value);
		return parsed === null || parsed === undefined
			? { ok: false, issue }
			: { ok: true, value: parsed };
	};
}

/** Why a body was refused. `status` is the HTTP status a transport answers with. */
export type JsonBodyFailure =
	| { readonly kind: 'too_large'; readonly status: 413; readonly message: string }
	| { readonly kind: 'unreadable'; readonly status: 400; readonly message: string }
	| { readonly kind: 'empty'; readonly status: 400; readonly message: string }
	| { readonly kind: 'malformed'; readonly status: 400; readonly message: string }
	| {
			readonly kind: 'invalid';
			readonly status: 400;
			readonly message: string;
			/** Where the value failed (`$.recipients[1]: expected string`). */
			readonly issue: string;
	  };

export type JsonBody<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly failure: JsonBodyFailure };

/** What a body is read from: a fetch `Request`, or a transport's equivalent. */
export interface JsonBodySource {
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: { get(name: string): string | null };
}

/** The parts of a Node `IncomingMessage` (Nitro's `event.node.req`) a body is read from. */
export interface NodeRequest {
	readonly headers: IncomingHttpHeaders;
	readonly readableEnded: boolean;
	on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	removeListener(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
	removeListener(event: 'end', listener: () => void): unknown;
	removeListener(event: 'error', listener: (error: Error) => void): unknown;
	pause(): unknown;
	resume(): unknown;
}

/**
 * A Node request as a {@link JsonBodySource}, with backpressure: the request
 * is paused whenever the reader has a chunk it has not taken yet.
 *
 * Cancelling (what {@link decodeJson} does past the cap) stops buffering and
 * lets Node discard the rest of the body rather than destroying the request,
 * so the transport can still answer 413 on the same socket.
 */
export function nodeRequestSource(req: NodeRequest): JsonBodySource {
	const headers = {
		get(name: string): string | null {
			const value = req.headers[name.toLowerCase()];
			return typeof value === 'string' ? value : null;
		},
	};
	// Nothing left to read: an empty body, not a read that never ends.
	if (req.readableEnded) return { body: null, headers };

	const listeners: {
		data?: (chunk: Uint8Array) => void;
		end?: () => void;
		error?: (error: Error) => void;
	} = {};
	const detach = () => {
		if (listeners.data) req.removeListener('data', listeners.data);
		if (listeners.end) req.removeListener('end', listeners.end);
		if (listeners.error) req.removeListener('error', listeners.error);
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			listeners.data = (chunk) => {
				controller.enqueue(chunk);
				if ((controller.desiredSize ?? 0) <= 0) req.pause();
			};
			listeners.end = () => {
				detach();
				controller.close();
			};
			listeners.error = (error) => {
				detach();
				controller.error(error);
			};
			req.on('data', listeners.data);
			req.on('end', listeners.end);
			req.on('error', listeners.error);
		},
		pull() {
			req.resume();
		},
		cancel() {
			detach();
			// The rest of the body is drained and dropped; a late socket error has
			// nobody left to tell and must not become an unhandled 'error' event.
			req.on('error', ignore);
			req.resume();
		},
	});
	return { body, headers };
}

function ignore(): void {}

export interface DecodeJsonOptions {
	/**
	 * What an empty body (no bytes, or only whitespace) stands for. It is run
	 * through the decoder like any parsed value. Absent: an empty body is
	 * refused. A route that historically accepted a body-less POST passes `{}`
	 * here, and a malformed non-empty body is still refused.
	 */
	readonly emptyBody?: unknown;
}

const FAILURE = {
	tooLarge: { kind: 'too_large', status: 413, message: 'Request body too large' },
	unreadable: { kind: 'unreadable', status: 400, message: 'Request body could not be read' },
	empty: { kind: 'empty', status: 400, message: 'Request body is empty' },
	malformed: { kind: 'malformed', status: 400, message: 'Request body is not valid JSON' },
} as const satisfies Record<string, JsonBodyFailure>;

/** What a body is checked with: a Convex validator, or a decoder. */
export type JsonChecker = GenericValidator | JsonDecoder<unknown>;

/** The type a checker narrows a value to. */
export type Checked<C extends JsonChecker> =
	C extends JsonDecoder<infer T> ? T : C extends GenericValidator ? Infer<C> : never;

function asDecoder<C extends JsonChecker>(checker: C): JsonDecoder<Checked<C>> {
	// The overload-free signature erases which arm `C` is; the two conversions
	// below are exactly what `Checked` computes for each.
	return (typeof checker === 'function' ? checker : validatorDecoder(checker)) as JsonDecoder<
		Checked<C>
	>;
}

/**
 * Read at most `maxBytes` of a request body, parse it as JSON and check it.
 *
 * The cap is on the real streamed octets: a `Content-Length` above it is
 * refused before a byte is read, and a missing or understated one cannot get
 * more than `maxBytes` buffered, because the read stops at the cap and cancels
 * the stream. A body that is not UTF-8 is malformed.
 */
export async function decodeJson<C extends JsonChecker>(
	source: JsonBodySource,
	checker: C,
	maxBytes: number,
	options: DecodeJsonOptions = {}
): Promise<JsonBody<Checked<C>>> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError('maxBytes must be a non-negative safe integer');
	}
	const declared = declaredLength(source.headers.get('content-length'));
	if (declared !== undefined && declared > maxBytes) {
		void source.body?.cancel().catch(() => undefined);
		return { ok: false, failure: FAILURE.tooLarge };
	}
	let read: Awaited<ReturnType<typeof readStreamPrefix>>;
	try {
		read = await readStreamPrefix(source.body, maxBytes);
	} catch {
		return { ok: false, failure: FAILURE.unreadable };
	}
	if (read?.truncated) return { ok: false, failure: FAILURE.tooLarge };
	let text: string;
	try {
		text = read ? new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) : '';
	} catch {
		return { ok: false, failure: FAILURE.malformed };
	}
	return decodeJsonText(text, checker, options);
}

/**
 * Parse and check JSON text a transport has already read: a signed webhook,
 * whose signature has to be verified over the exact bytes first, cannot hand
 * its request to {@link decodeJson} a second time.
 */
export function decodeJsonText<C extends JsonChecker>(
	text: string,
	checker: C,
	options: DecodeJsonOptions = {}
): JsonBody<Checked<C>> {
	let parsed: unknown;
	if (text.trim() === '') {
		if (options.emptyBody === undefined) return { ok: false, failure: FAILURE.empty };
		parsed = options.emptyBody;
	} else {
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, failure: FAILURE.malformed };
		}
	}
	return decodeJsonValue(parsed, checker);
}

/**
 * Check a value a framework has already parsed (Convex's `request.json()`
 * behind a body cap, an RPC argument typed `any`).
 */
export function decodeJsonValue<C extends JsonChecker>(
	value: unknown,
	checker: C
): JsonBody<Checked<C>> {
	const decoded = asDecoder(checker)(value);
	if (decoded.ok) return { ok: true, value: decoded.value };
	return {
		ok: false,
		failure: {
			kind: 'invalid',
			status: 400,
			message: `Invalid request body: ${decoded.issue}`,
			issue: decoded.issue,
		},
	};
}

/** A `Content-Length` that states a length; anything else is no claim at all. */
function declaredLength(header: string | null): number | undefined {
	if (header === null || !/^\s*\d+\s*$/.test(header)) return undefined;
	const value = Number(header);
	return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}
