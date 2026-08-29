import { describe, expect, it } from 'vitest';
import { moveSibling } from '../postboxReorder';

describe('moveSibling', () => {
	it('moves one slot in either direction', () => {
		expect(moveSibling(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
		expect(moveSibling(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
	});

	it('refuses to fall off either end, so the caller can skip the write', () => {
		expect(moveSibling(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
		expect(moveSibling(['a', 'b'], 'b', 1)).toEqual(['a', 'b']);
	});

	it('leaves an unknown id alone rather than inserting it', () => {
		expect(moveSibling(['a', 'b'], 'missing', 1)).toEqual(['a', 'b']);
	});

	it('returns a copy, never the input array', () => {
		const input = ['a', 'b'];
		expect(moveSibling(input, 'a', -1)).not.toBe(input);
	});
});
