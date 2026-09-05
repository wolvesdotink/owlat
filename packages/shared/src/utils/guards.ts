/**
 * Narrow an unknown value to a keyed object. Arrays are excluded on purpose:
 * every caller reads string keys out of parsed JSON, and an array is never a
 * valid shape there.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
