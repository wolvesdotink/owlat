import type { z } from 'zod';

/** A decoded request, or the message of the first fault found. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; message: string };

const PROTO_KEY = '__proto__';

/** Whether a parsed JSON value holds an own `__proto__` key at any depth. */
function holdsProtoKey(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(holdsProtoKey);
	if (value === null || typeof value !== 'object') return false;
	return Object.entries(value).some(([key, inner]) => key === PROTO_KEY || holdsProtoKey(inner));
}

/**
 * A copy of a parsed JSON value in which every own `__proto__` key is renamed
 * to a key no other key of its object uses, so the parser checks its value.
 */
function withProtoKeysRenamed(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withProtoKeysRenamed);
	if (value === null || typeof value !== 'object') return value;
	const copy: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		let name = key;
		if (key === PROTO_KEY) {
			name = `${PROTO_KEY}_`;
			while (Object.prototype.hasOwnProperty.call(value, name)) name = `${name}_`;
		}
		copy[name] = withProtoKeysRenamed(inner);
	}
	return copy;
}

/**
 * Check `input`, a parsed JSON value, against a request schema.
 *
 * On success the caller gets its own `input` back, typed, rather than the
 * parser's copy: the request schemas have no defaults or transforms, and
 * handing back the object as sent keeps unknown fields, key order and every
 * value exactly as the client wrote them, so idempotency fingerprints and byte
 * budgets computed from it cannot change because a schema was introduced.
 *
 * Handing back the input is only safe if the parser looked at all of it. zod
 * skips an own `__proto__` key in objects and records without checking its
 * value (copying it would replace the copy's prototype), and `JSON.parse`
 * creates such keys, so `{"dataVariables":{"__proto__":{"a":1}}}` would pass
 * with a nested value the handler then receives. An input holding one is
 * therefore checked as a copy with that key renamed: a record entry's value
 * is checked like any other, an unknown field is still ignored.
 *
 * Every schema here attaches its own message to each rule, so the first issue
 * is always one of the API's documented messages.
 */
export function decodeRequest<Schema extends z.ZodType>(
	schema: Schema,
	input: unknown
): Decoded<z.output<Schema>> {
	const result = schema.safeParse(holdsProtoKey(input) ? withProtoKeysRenamed(input) : input);
	if (result.success) return { ok: true, value: input as z.output<Schema> };
	return { ok: false, message: result.error.issues[0]?.message ?? 'Invalid request body' };
}
