/**
 * Byte-array equality for tests, for arrays too large for `toEqual`.
 *
 * `toEqual` walks a typed array element by element through its generic deep
 * equality, about 3 µs a byte under coverage, so a few 1 MB comparisons
 * outran the 10 s test timeout on CI. `Buffer.equals` compares them natively.
 * Assert `expect(firstDifference(actual, expected)).toBe(-1)`; a mismatch
 * reports where the arrays part.
 */

/**
 * The index of the first byte where `a` and `b` differ (the shorter length
 * when one is a prefix of the other), or -1 when they are the same bytes.
 */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
	const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view(a).equals(view(b))) return -1;
	const shorter = Math.min(a.length, b.length);
	for (let i = 0; i < shorter; i++) if (a[i] !== b[i]) return i;
	return shorter;
}
