/**
 * The **thrown (in-app) adapter** at the Operation error seam: every
 * user-facing Convex function reports failure by throwing
 * `ConvexError(OperationError)`, so the Vue client reads one shape off
 * `error.data` — `{ category, message, data? }`.
 *
 * The canonical category union, the `OperationError` shape, and the
 * category→HTTP-status map live in `@owlat/shared` (`operationError.ts`) so the
 * HTTP adapter (`lib/httpResponse.ts`) and the `apps/web` Operation modules
 * speak the same vocabulary. This module re-exports them and adds the throwers.
 */

import { ConvexError, type Value } from 'convex/values';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import {
	type OperationError,
	type OperationErrorCategory,
	categoryToHttpStatus,
} from '@owlat/shared/operationError';
export type { OperationError, OperationErrorCategory };
export { categoryToHttpStatus };

/**
 * Categories a server can originate. `network` is client-only (a transport
 * failure never starts inside a Convex function), so the throwers cannot emit
 * it.
 */
type ThrowableCategory = Exclude<OperationErrorCategory, 'network'>;

/**
 * The one place a `ConvexError(OperationError)` is constructed. Keeps the wire
 * payload identical to the `OperationError` contract: `error.data` on the
 * client is exactly `{ category, message, data? }`.
 */
function throwOperationError(
	category: ThrowableCategory,
	message: string,
	data?: Record<string, unknown>
): never {
	const payload: OperationError = { category, message };
	if (data !== undefined) payload.data = data;
	// `OperationError.data` is `Record<string, unknown>` for cross-seam ergonomics;
	// the runtime payload is a valid Convex `Value`, so the cast is sound.
	throw new ConvexError(payload as unknown as Value);
}

export function throwUnauthenticated(message = 'Not authenticated'): never {
	throwOperationError('unauthenticated', message);
}

export function throwForbidden(message: string, data?: Record<string, unknown>): never {
	throwOperationError('forbidden', message, data);
}

export function throwNotFound(resource: string): never {
	throwOperationError('not_found', `${resource} not found`);
}

/**
 * Load a document by id or throw `not_found`. Collapses the ubiquitous
 * `const x = await ctx.db.get(id); if (!x) throwNotFound('Label')` pattern into
 * one call. The `ctx` param is structurally typed on just `db.get`, so both
 * `QueryCtx` and `MutationCtx` (and any other reader) satisfy it.
 */
export async function getOrThrow<T extends TableNames>(
	ctx: { db: { get<TN extends TableNames>(id: Id<TN>): Promise<Doc<TN> | null> } },
	id: Id<T>,
	label: string
): Promise<Doc<T>> {
	const doc = await ctx.db.get(id);
	if (!doc) throwNotFound(label);
	return doc;
}

export function throwInvalidInput(message: string, data?: Record<string, unknown>): never {
	throwOperationError('invalid_input', message, data);
}

export function throwAlreadyExists(message: string, data?: Record<string, unknown>): never {
	throwOperationError('already_exists', message, data);
}

export function throwConflict(message: string, data?: Record<string, unknown>): never {
	throwOperationError('conflict', message, data);
}

export function throwInvalidState(message: string, data?: Record<string, unknown>): never {
	throwOperationError('invalid_state', message, data);
}

export function throwRateLimited(message: string, retryAfter?: number): never {
	throwOperationError(
		'rate_limited',
		message,
		retryAfter !== undefined ? { retryAfter } : undefined
	);
}

export function throwInternal(message: string, data?: Record<string, unknown>): never {
	throwOperationError('internal', message, data);
}

// ─── Internal failures ──────────────────────────────────────────────────────
//
// A failure one backend module raises for another backend module to classify:
// never a user-facing outcome, always something a caller branches on. Callers
// switch on `kind`, never on message text, so rewording a message cannot
// reclassify a failure and an unrelated error that happens to use the same
// words cannot impersonate one.
//
// It travels as a `ConvexError`. A plain `Error` subclass does not survive a
// nested `ctx.runMutation`/`runQuery`/`runAction`: the runtime rethrows it as a
// new `Error` carrying only its message, so `instanceof` stops working one call
// up. A `ConvexError` keeps its `data`, which `internalFailureOf` reads back.
//
// The payload is an `OperationError` with category `internal`, so a failure
// that escapes to a client still reads as one. Everything in it is bounded:
// the kind from the closed list below, a boolean, and a handful of short,
// address-free attributes. Raw causes and message text never enter it.

/**
 * The closed list of internal failure kinds, per domain. A new kind is added
 * here; a classifier that maps kinds to its own codes switches on the union.
 */
const INTERNAL_FAILURE_KINDS = {
	delivery: ['send_identity_conflict', 'unhandled_worker_outcome', 'envelope_not_stored'],
	mta: ['dkim_ownership_conflict'],
} as const;

type InternalFailureDomain = keyof typeof INTERNAL_FAILURE_KINDS;

export type InternalFailureKind = {
	[D in InternalFailureDomain]: `${D}.${(typeof INTERNAL_FAILURE_KINDS)[D][number]}`;
}[InternalFailureDomain];

const KNOWN_KINDS: ReadonlySet<string> = new Set(
	Object.entries(INTERNAL_FAILURE_KINDS).flatMap(([domain, kinds]) =>
		kinds.map((kind) => `${domain}.${kind}`)
	)
);

function isInternalFailureKind(value: unknown): value is InternalFailureKind {
	return typeof value === 'string' && KNOWN_KINDS.has(value);
}

/** Short identifiers and numbers only: no prose, no addresses, no payloads. */
export type InternalFailureAttrs = Readonly<Record<string, string | number | boolean>>;

const ATTRS_MAX_ENTRIES = 8;
const ATTR_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ATTR_STRING_PATTERN = /^[A-Za-z0-9._:#-]{0,64}$/;
/** Stands in for a string attribute that is not a short identifier. */
const UNSAFE_ATTR = '<unsafe>';

/**
 * The attributes as they may be stored and serialized: at most eight, each key
 * a short identifier, each string value a short identifier too (so an address,
 * a sentence or a JSON blob cannot ride along), each number finite.
 */
function boundAttrs(attrs: InternalFailureAttrs | undefined): InternalFailureAttrs {
	const bounded: Record<string, string | number | boolean> = {};
	if (attrs === undefined) return bounded;
	let count = 0;
	for (const [key, value] of Object.entries(attrs)) {
		if (count >= ATTRS_MAX_ENTRIES) break;
		if (!ATTR_KEY_PATTERN.test(key)) continue;
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) continue;
			bounded[key] = value;
		} else if (typeof value === 'boolean') {
			bounded[key] = value;
		} else if (typeof value === 'string') {
			bounded[key] = ATTR_STRING_PATTERN.test(value) ? value : UNSAFE_ATTR;
		} else {
			continue;
		}
		count += 1;
	}
	return bounded;
}

/** What a caller reads off an internal failure, local or rebuilt by the runtime. */
export interface InternalFailureInfo {
	kind: InternalFailureKind;
	/**
	 * Whether the same call may succeed if repeated. Descriptive only: retry and
	 * scheduling decisions stay with their own policy modules.
	 */
	retryable: boolean;
	attrs: InternalFailureAttrs;
}

/** The fixed client-facing text of an internal failure. */
const INTERNAL_FAILURE_MESSAGE = 'Internal error';

// A type alias, not an interface: `ConvexError` needs a `Value`, and only an
// alias carries the implicit index signature that makes it one.
type InternalFailurePayload = {
	category: 'internal';
	message: string;
	data: { internalFailure: { kind: string; retryable: boolean; attrs: InternalFailureAttrs } };
};

export interface InternalFailureOptions {
	retryable: boolean;
	attrs?: InternalFailureAttrs;
	/**
	 * The error's own message, for logs and operator-facing records that show
	 * it, as a plain `Error`'s would be. Defaults to the kind and attributes.
	 * Never part of `data`, and never what a caller classifies on; like any
	 * error message it must stay free of addresses and content if the failure
	 * can reach a client.
	 */
	message?: string;
}

/**
 * A typed failure between backend modules. Throw it where a caller has to tell
 * this failure apart from others; read it with `internalFailureOf`.
 */
export class InternalFailure extends ConvexError<InternalFailurePayload> {
	readonly kind: InternalFailureKind;
	readonly retryable: boolean;
	readonly attrs: InternalFailureAttrs;

	constructor(kind: InternalFailureKind, options: InternalFailureOptions) {
		const attrs = boundAttrs(options.attrs);
		super({
			category: 'internal',
			message: INTERNAL_FAILURE_MESSAGE,
			data: { internalFailure: { kind, retryable: options.retryable, attrs } },
		});
		this.name = 'InternalFailure';
		this.message =
			options.message ??
			(Object.keys(attrs).length > 0 ? `${kind} ${JSON.stringify(attrs)}` : kind);
		this.kind = kind;
		this.retryable = options.retryable;
		this.attrs = attrs;
	}
}

/**
 * The internal failure carried by a thrown value, or `null`. Reads the
 * serialized payload rather than the class, so it also recognises a failure
 * the runtime rebuilt on its way out of a nested Convex call. A kind this
 * build does not know is not a typed failure here.
 */
export function internalFailureOf(error: unknown): InternalFailureInfo | null {
	if (error instanceof InternalFailure) {
		return { kind: error.kind, retryable: error.retryable, attrs: error.attrs };
	}
	if (!(error instanceof ConvexError)) return null;
	const data: unknown = error.data;
	if (typeof data !== 'object' || data === null) return null;
	const payload = data as Record<string, unknown>;
	if (payload['category'] !== 'internal') return null;
	const inner = payload['data'];
	if (typeof inner !== 'object' || inner === null) return null;
	const failure = (inner as Record<string, unknown>)['internalFailure'];
	if (typeof failure !== 'object' || failure === null) return null;
	const { kind, retryable, attrs } = failure as Record<string, unknown>;
	if (!isInternalFailureKind(kind) || typeof retryable !== 'boolean') return null;
	return {
		kind,
		retryable,
		attrs: boundAttrs(
			typeof attrs === 'object' && attrs !== null && !Array.isArray(attrs)
				? (attrs as InternalFailureAttrs)
				: undefined
		),
	};
}
