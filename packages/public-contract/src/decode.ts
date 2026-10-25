import type { z } from 'zod';

/** A decoded request, or the message of the first fault found. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; message: string };

const PROTO_KEY = '__proto__';

type Container = unknown[] | Record<string, unknown>;

const isContainer = (value: unknown): value is Container =>
	value !== null && typeof value === 'object';

// Both walks below use an explicit stack, not recursion: they run before the
// schema, over every field of the body including ignored ones, and a client can
// nest a few thousand arrays well inside the body size cap. Recursion would
// overflow the call stack there and turn a valid request into a 500.

/** Whether a parsed JSON value holds an own `__proto__` key at any depth. */
function holdsProtoKey(value: unknown): boolean {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!isContainer(current)) continue;
		if (Array.isArray(current)) {
			for (const item of current) pending.push(item);
			continue;
		}
		for (const [key, inner] of Object.entries(current)) {
			if (key === PROTO_KEY) return true;
			pending.push(inner);
		}
	}
	return false;
}

/**
 * A copy of a parsed JSON value in which every own `__proto__` key is renamed
 * to a key no other key of its object uses, so the parser checks its value.
 */
function withProtoKeysRenamed(value: unknown): unknown {
	if (!isContainer(value)) return value;
	const emptyLike = (source: Container): Container => (Array.isArray(source) ? [] : {});
	const root = emptyLike(value);
	const pending: Array<[source: Container, copy: Container]> = [[value, root]];
	for (let entry = pending.pop(); entry; entry = pending.pop()) {
		const [source, copy] = entry;
		const target = copy as Record<string, unknown>;
		for (const [key, inner] of Object.entries(source)) {
			let name = key;
			if (key === PROTO_KEY && !Array.isArray(source)) {
				name = `${PROTO_KEY}_`;
				while (Object.prototype.hasOwnProperty.call(source, name)) name = `${name}_`;
			}
			if (isContainer(inner)) {
				const innerCopy = emptyLike(inner);
				pending.push([inner, innerCopy]);
				target[name] = innerCopy;
			} else {
				target[name] = inner;
			}
		}
	}
	return root;
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
