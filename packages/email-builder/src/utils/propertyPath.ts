/**
 * Dotted-path property access for block content.
 *
 * A property key may be a plain key (`"color"`) or a dotted path into nested
 * objects (`"labels.days"`). These helpers centralise the get/set traversal so
 * every property-panel surface (toolbar, panel, builder) reads and writes the
 * same shape with identical null handling.
 */

/**
 * Read a value at a dotted path. Returns `undefined` if any intermediate value
 * along the path is missing or not an object.
 */
export function getByPath(obj: unknown, path: string): unknown {
	const parts = path.split('.');
	let value: unknown = obj;
	for (const part of parts) {
		if (value == null || typeof value !== 'object') return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

/**
 * Immutably set a value at a dotted path, cloning every object along the way so
 * the original is never mutated. Missing intermediate objects are created.
 *
 * Returns a new root object; the input `obj` is left untouched.
 */
export function setByPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
	const parts = path.split('.');
	const root = { ...obj } as Record<string, unknown>;
	let target = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		target[part] = { ...(target[part] as Record<string, unknown>) };
		target = target[part] as Record<string, unknown>;
	}
	target[parts[parts.length - 1]!] = value;
	return root as T;
}
