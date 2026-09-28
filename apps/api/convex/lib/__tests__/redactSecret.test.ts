import { describe, expect, it } from 'vitest';
import { redactSecret } from '../redactSecret';

describe('redactSecret', () => {
	it('replaces every occurrence of the secret', () => {
		expect(redactSecret('key=sk-1 and again sk-1.', 'sk-1')).toBe(
			'key=[redacted] and again [redacted].'
		);
	});

	it('leaves text without the secret unchanged', () => {
		expect(redactSecret('nothing to hide', 'sk-1')).toBe('nothing to hide');
	});

	it('is a no-op for an empty or absent secret', () => {
		// `split('')` would interleave the marker between every character.
		expect(redactSecret('abc', '')).toBe('abc');
		expect(redactSecret('abc', undefined)).toBe('abc');
	});

	it('treats the secret literally, not as a pattern', () => {
		expect(redactSecret('a.b+c a-b-c', 'a.b+c')).toBe('[redacted] a-b-c');
	});
});
