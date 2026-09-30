/**
 * `JSON.stringify` with every object's keys in a fixed order.
 *
 * Callers compare or digest the result, so two values that JSON would persist
 * identically must produce identical text here, whatever order their keys were
 * written in. The rule is therefore "exactly what `JSON.stringify` emits, keys
 * sorted", and every edge case follows `JSON.stringify` rather than being
 * decided locally:
 *
 * - an `undefined`, function or symbol object member is omitted, so an
 *   explicitly undefined optional field equals its absence (and equals what a
 *   JSON round trip of the persisted value reads back);
 * - the same values inside an array become `null`, keeping positions;
 * - `null` is kept, so `null` and absence stay distinct;
 * - `NaN` and `±Infinity` become `null`, as `JSON.stringify` writes them;
 * - `toJSON` is honoured;
 * - a bigint or a cycle throws a `TypeError`.
 *
 * Boxed primitives (`new Number(1)`) are outside the contract: no caller builds
 * them, and unwrapping them realm-safely is not worth the code.
 *
 * Keys are sorted by UTF-16 code unit (the default `Array.prototype.sort`
 * order), which is independent of locale and of insertion order, including for
 * integer-like keys that JavaScript would otherwise enumerate first.
 *
 * Unlike `JSON.stringify`, a top-level value with no JSON text (`undefined`, a
 * function, a symbol) throws instead of returning `undefined`, so the result is
 * always a string.
 *
 * Signed or hashed bytes depend on this output. Changing it changes digests and
 * signatures computed by earlier releases; the golden vectors in the tests of
 * those consumers pin it.
 */
export function canonicalJson(value: unknown): string {
	const text = serialize(value, '', new Set());
	if (text === undefined) throw new TypeError('Value has no JSON representation');
	return text;
}

function serialize(value: unknown, key: string, ancestors: Set<object>): string | undefined {
	let current = value;
	if ((typeof current === 'object' && current !== null) || typeof current === 'bigint') {
		const toJSON = (current as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') current = toJSON.call(current, key);
	}
	if (current === null) return 'null';
	switch (typeof current) {
		case 'string':
		case 'number':
		case 'boolean':
			return JSON.stringify(current);
		case 'bigint':
			throw new TypeError('Do not know how to serialize a BigInt');
		case 'object':
			break;
		default:
			return undefined;
	}

	if (ancestors.has(current)) throw new TypeError('Converting circular structure to JSON');
	ancestors.add(current);
	try {
		if (Array.isArray(current)) {
			const items: string[] = [];
			// An index loop, not `map`: `map` skips holes, JSON writes them as null.
			for (let index = 0; index < current.length; index++) {
				items.push(serialize(current[index], String(index), ancestors) ?? 'null');
			}
			return `[${items.join(',')}]`;
		}
		const record = current as Record<string, unknown>;
		const members: string[] = [];
		for (const member of Object.keys(record).sort()) {
			const text = serialize(record[member], member, ancestors);
			if (text !== undefined) members.push(`${JSON.stringify(member)}:${text}`);
		}
		return `{${members.join(',')}}`;
	} finally {
		ancestors.delete(current);
	}
}
