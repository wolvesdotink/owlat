import { toRaw } from 'vue';

/**
 * Deep-copy editor state (blocks, history entries) into plain, non-reactive
 * data, with the result `JSON.parse(JSON.stringify(value))` would give.
 *
 * `structuredClone` cannot do this job on its own. It throws on a Vue proxy,
 * and `toRaw` only unwraps the outermost one: a block written back into the
 * canvas as `{ ...block, content: { ...block.content, [key]: value } }` keeps
 * the proxies it spread out of the old block (its items, its linked-block ref)
 * as plain properties of a raw object. Walking the tree and unwrapping every
 * node covers those, and skips the string round trip.
 *
 * The JSON rules are kept on purpose, because they are what the editor has
 * always produced here: an `undefined` property is dropped, `undefined` in an
 * array and non-finite numbers become `null`, and `toJSON` is honoured.
 */
export function plainClone<T>(value: T): T {
	return cloneValue(value) as T;
}

function cloneValue(input: unknown): unknown {
	const value = toRaw(input);
	if (value === null) return null;
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : null;
		case 'object':
			break;
		default:
			// undefined, functions, symbols, bigint: callers decide per position.
			return undefined;
	}
	const withToJson = value as { toJSON?: () => unknown };
	if (typeof withToJson.toJSON === 'function') return cloneValue(withToJson.toJSON());
	if (Array.isArray(value)) {
		return value.map((item) => {
			const cloned = cloneValue(item);
			return cloned === undefined ? null : cloned;
		});
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const cloned = cloneValue((value as Record<string, unknown>)[key]);
		if (cloned !== undefined) out[key] = cloned;
	}
	return out;
}
