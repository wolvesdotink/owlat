/**
 * Deep-copy plain data with the result `JSON.parse(JSON.stringify(value))`
 * would give, without the string round trip: an `undefined` property is
 * dropped, `undefined` in an array and non-finite numbers become `null`, and
 * `toJSON` is honoured.
 *
 * It walks the value through ordinary property reads, so a Vue reactive proxy
 * (which `structuredClone` rejects) is copied like the object behind it, and
 * the copy holds no proxies. The editor's own `plainClone` follows the same
 * rules and also unwraps each node with Vue's `toRaw`; this module cannot
 * import Vue.
 */
export function jsonClone<T>(value: T): T {
	// The copy has the shape of `value` under the JSON rules above, which is
	// what every caller hands in: plain data that already survives them.
	return cloneValue(value) as T;
}

function cloneValue(value: unknown): unknown {
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
			// undefined, functions, symbols (and bigint, which JSON.stringify
			// refuses outright): the caller decides per position.
			return undefined;
	}
	const withToJson = value as { toJSON?: () => unknown };
	if (typeof withToJson.toJSON === 'function') return cloneValue(withToJson.toJSON());
	if (Array.isArray(value)) {
		return value.map((item: unknown) => {
			const cloned = cloneValue(item);
			return cloned === undefined ? null : cloned;
		});
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const cloned = cloneValue((value as Record<string, unknown>)[key]);
		if (cloned === undefined) continue;
		// `JSON.parse` keeps a `"__proto__"` key as an own property; a plain
		// assignment would set the copy's prototype instead.
		if (key === '__proto__') {
			Object.defineProperty(out, key, {
				value: cloned,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			out[key] = cloned;
		}
	}
	return out;
}
