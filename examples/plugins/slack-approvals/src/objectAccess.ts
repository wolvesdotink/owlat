/**
 * Defensive readers for untrusted, externally-parsed objects (Owlat hook
 * payloads and Slack interaction bodies). They read ONLY own-enumerable data
 * properties, so an inherited or non-enumerable key (`__proto__`, an accessor
 * that throws) can never smuggle a value in or run code during a read.
 *
 * Shared here because the gate handler and the notifier both needed the same
 * string reader and had drifted apart — one required a non-empty string, the
 * other allowed the empty string. One helper with an explicit `allowEmpty`
 * option keeps that difference intentional and in one place.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the value of an own-enumerable data property, or `undefined` if `value`
 * is not a plain object, the key is absent/inherited/non-enumerable, or it is an
 * accessor rather than a data property.
 */
export function readOwnProperty(value: unknown, key: string): unknown {
	if (!isPlainObject(value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
	return descriptor.value;
}

export interface ReadOwnStringOptions {
	/**
	 * When true, an own-enumerable empty string is returned as `''`; when false
	 * (the default) an empty string reads as `undefined` (treated as absent).
	 */
	readonly allowEmpty?: boolean;
}

/**
 * Read an own-enumerable STRING property. Non-strings, and (unless
 * `allowEmpty`) the empty string, read as `undefined`.
 */
export function readOwnString(
	value: unknown,
	key: string,
	options?: ReadOwnStringOptions
): string | undefined {
	const own = readOwnProperty(value, key);
	if (typeof own !== 'string') return undefined;
	if (own.length === 0 && options?.allowEmpty !== true) return undefined;
	return own;
}
