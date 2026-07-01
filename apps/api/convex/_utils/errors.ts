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
 *
 * See docs/adr/0036-operation-error-taxonomy.md.
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
	data?: Record<string, unknown>,
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
	label: string,
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
		retryAfter !== undefined ? { retryAfter } : undefined,
	);
}

export function throwLimitReached(message: string, data?: Record<string, unknown>): never {
	throwOperationError('limit_reached', message, data);
}

export function throwInternal(message: string, data?: Record<string, unknown>): never {
	throwOperationError('internal', message, data);
}

