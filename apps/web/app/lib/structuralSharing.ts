/**
 * Structural sharing for Convex query results.
 *
 * Every push from Convex is a freshly parsed value: all new objects, even for
 * rows that did not change. Stored as-is, each update hands every mounted row a
 * new object and every row re-renders. `shareStructure` keeps the parts of the
 * previous value that are deep-equal to the next one, so an update that touches
 * one row replaces that row (and the arrays and objects on its path) and nothing
 * else, and an update that changes nothing returns the previous value itself.
 *
 * Arrays of documents are matched by `_id`, not by position, so a row keeps its
 * object when a new row is inserted above it or the list is re-sorted. Arrays of
 * anything else are matched by position.
 *
 * Only plain objects and arrays are walked. Anything else (an `ArrayBuffer`
 * from a `bytes` field, say) is taken from the next value unless it is the very
 * same value. Primitives, `bigint` included, compare by value.
 *
 * The result shares objects with the previous value, so callers must treat
 * both as immutable, which query results already are.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	if (value === null || typeof value !== 'object') return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** The `_id` of a Convex document, or `undefined` for anything else. */
function documentId(value: unknown): string | undefined {
	if (!isPlainObject(value)) return undefined;
	const id = value['_id'];
	return typeof id === 'string' ? id : undefined;
}

function indexById(rows: readonly unknown[]): Map<string, unknown> {
	const byId = new Map<string, unknown>();
	for (const row of rows) {
		const id = documentId(row);
		// First occurrence wins; a duplicate id reuses the same (equal) object.
		if (id !== undefined && !byId.has(id)) byId.set(id, row);
	}
	return byId;
}

function shareArray(prev: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
	let byId: Map<string, unknown> | undefined;
	let unchanged = prev.length === next.length;
	const out = Array.from<unknown>({ length: next.length });
	for (let i = 0; i < next.length; i++) {
		const item = next[i];
		const id = documentId(item);
		let match: unknown;
		if (id === undefined) {
			match = prev[i];
		} else if (documentId(prev[i]) === id) {
			// Same row at the same position: the common case, no index needed.
			match = prev[i];
		} else {
			byId ??= indexById(prev);
			match = byId.get(id);
		}
		const shared = shareStructure(match, item);
		out[i] = shared;
		if (shared !== prev[i]) unchanged = false;
	}
	return unchanged ? prev : out;
}

function shareObject(prev: PlainObject, next: PlainObject): PlainObject {
	const nextKeys = Object.keys(next);
	let unchanged = nextKeys.length === Object.keys(prev).length;
	const out: PlainObject = {};
	for (const key of nextKeys) {
		const had = Object.hasOwn(prev, key);
		const shared = shareStructure(had ? prev[key] : undefined, next[key]);
		out[key] = shared;
		if (!had || shared !== prev[key]) unchanged = false;
	}
	return unchanged ? prev : out;
}

/**
 * `next`, with every part that is deep-equal to the matching part of `prev`
 * replaced by that part of `prev`. Returns `prev` itself when the two are
 * deep-equal.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
	if (Object.is(prev, next)) return prev as T;
	if (Array.isArray(prev) && Array.isArray(next)) return shareArray(prev, next) as T;
	if (isPlainObject(prev) && isPlainObject(next)) return shareObject(prev, next) as T;
	return next;
}
