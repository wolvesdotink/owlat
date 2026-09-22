import { describe, expect, it } from 'vitest';
import { truncateCodePoints } from '../unicode';

describe('truncateCodePoints', () => {
	it.each([
		['abc', 0, ''],
		['abc', 2, 'ab'],
		['a😀b', 2, 'a😀'],
		['😀😀', 2, '😀😀'],
		['hello', 10, 'hello'],
		['', 1, ''],
	] as const)('truncates %s to %i code points', (value, limit, expected) => {
		expect(truncateCodePoints(value, limit)).toBe(expected);
	});
});
