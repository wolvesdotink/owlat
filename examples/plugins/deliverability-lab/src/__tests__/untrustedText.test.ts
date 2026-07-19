import { describe, expect, it } from 'vitest';
import { clampUntrustedText } from '../untrustedText';

describe('clampUntrustedText', () => {
	it('strips C0/C7F control characters to spaces', () => {
		const clamped = clampUntrustedText('a\x00b\x1fc\x7fd', 100);
		expect(clamped).toBe('a b c d');
		expect(clamped).not.toContain('\x00');
		expect(clamped).not.toContain('\x1f');
		expect(clamped).not.toContain('\x7f');
	});

	it('clamps to at most `max` code points', () => {
		expect(clampUntrustedText('x'.repeat(500), 200)).toHaveLength(200);
	});

	it('counts by code points so a surrogate pair is never split', () => {
		// Each astral emoji is one code point but two UTF-16 units.
		const clamped = clampUntrustedText('😀'.repeat(10), 3);
		expect([...clamped]).toHaveLength(3);
		expect(clamped).toBe('😀😀😀');
	});

	it('trims before slicing so leading control-char whitespace does not eat the budget', () => {
		expect(clampUntrustedText('\x00\x00abc', 3)).toBe('abc');
	});

	it('trims a trailing boundary space introduced by the slice', () => {
		// After control-strip: "ab c"; slicing 3 code points yields "ab " which trims to "ab".
		expect(clampUntrustedText('ab\x00c', 3)).toBe('ab');
	});

	it('returns an empty string for text that is only control characters', () => {
		expect(clampUntrustedText('\x00\x1f\x7f', 50)).toBe('');
	});
});
