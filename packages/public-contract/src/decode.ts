import type { z } from 'zod';

/** A decoded request, or the message of the first fault found. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Check `input` against a request schema.
 *
 * On success the caller gets its own `input` back, typed, rather than the
 * parser's copy: the request schemas have no defaults or transforms, and
 * handing back the object as sent keeps unknown fields, key order and every
 * value exactly as the client wrote them, so idempotency fingerprints and byte
 * budgets computed from it cannot change because a schema was introduced.
 *
 * Every schema here attaches its own message to each rule, so the first issue
 * is always one of the API's documented messages.
 */
export function decodeRequest<Schema extends z.ZodType>(
	schema: Schema,
	input: unknown
): Decoded<z.output<Schema>> {
	const result = schema.safeParse(input);
	if (result.success) return { ok: true, value: input as z.output<Schema> };
	return { ok: false, message: result.error.issues[0]?.message ?? 'Invalid request body' };
}
