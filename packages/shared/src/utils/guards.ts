/**
 * Narrow an unknown value to a keyed object. Arrays are excluded on purpose:
 * every caller reads string keys out of parsed JSON, and an array is never a
 * valid shape there.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow to a plain object literal (`{}` or `Object.create(null)`): class
 * instances, arrays, Dates and Maps are rejected. Use this where a value is
 * about to be walked key-by-key as data and anything with behaviour attached
 * must be refused rather than serialised.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
