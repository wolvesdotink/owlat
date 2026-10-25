/**
 * Readers for values a device keeps in localStorage (`useLocalStorage`). The
 * JSON there was written by some earlier build, an extension or a person in
 * devtools, so a reader checks it and answers `undefined` for anything it does
 * not accept; the caller's default stands in for it.
 */
export type StoredValueReader<T> = (stored: unknown) => T | undefined;

export const readStoredBoolean: StoredValueReader<boolean> = (stored) =>
	typeof stored === 'boolean' ? stored : undefined;

export const readStoredString: StoredValueReader<string> = (stored) =>
	typeof stored === 'string' ? stored : undefined;

export const readStoredFiniteNumber: StoredValueReader<number> = (stored) =>
	typeof stored === 'number' && Number.isFinite(stored) ? stored : undefined;

/** A list of strings; one with any other entry is not accepted. */
export const readStoredStringList: StoredValueReader<string[]> = (stored) =>
	Array.isArray(stored) && stored.every((entry) => typeof entry === 'string') ? stored : undefined;

/** One of `values`: a stored choice the current build no longer offers is not accepted. */
export function readStoredChoice<const V extends string>(
	values: readonly V[]
): StoredValueReader<V> {
	return (stored) => values.find((value) => value === stored);
}
