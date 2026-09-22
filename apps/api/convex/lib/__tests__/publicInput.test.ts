import { describe, expect, it } from 'vitest';
import { PUBLIC_STRING_MAX_CHARS, validatePublicInputStrings } from '../publicInput';

describe('public input string ceiling', () => {
	it('accepts the exact boundary and leaves values unchanged', () => {
		const value = {
			text: 'x'.repeat(PUBLIC_STRING_MAX_CHARS),
			values: [null, 1, false, 2n, new ArrayBuffer(8)],
		};
		expect(() => validatePublicInputStrings(value)).not.toThrow();
		expect(value.text.length).toBe(PUBLIC_STRING_MAX_CHARS);
	});
	it.each([
		(text: string) => text,
		(text: string) => ({ payload: [{ nested: text }] }),
		(text: string) => ({ [text]: true }),
	])('rejects over-limit strings, including dynamic keys', (wrap) => {
		expect(() => validatePublicInputStrings(wrap('x'.repeat(PUBLIC_STRING_MAX_CHARS + 1)))).toThrow(
			/at most/
		);
	});
});
