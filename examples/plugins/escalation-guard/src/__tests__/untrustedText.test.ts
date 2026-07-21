import { describe, expect, it } from 'vitest';
import { clampUntrustedText } from '../untrustedText';

describe('clampUntrustedText', () => {
	it('returns ordinary text unchanged', () => {
		expect(clampUntrustedText('Hello there.', 100)).toBe('Hello there.');
	});

	it('replaces control characters and collapses the resulting whitespace', () => {
		expect(clampUntrustedText('a\u0000\u0007b\u001fc', 100)).toBe('a b c');
	});

	it('trims after sanitizing so a boundary space is never returned', () => {
		expect(clampUntrustedText('\u0000  padded  \u007f', 100)).toBe('padded');
	});

	it('clamps to the requested number of code points', () => {
		expect(clampUntrustedText('abcdef', 3)).toBe('abc');
	});

	it('never splits a multibyte character across the boundary', () => {
		const clamped = clampUntrustedText('😀😀😀', 2);
		expect([...clamped]).toHaveLength(2);
		expect(clamped).toBe('😀😀');
	});

	it('returns an empty string for input that is only control characters', () => {
		expect(clampUntrustedText('\u0000\u0001\u0002', 100)).toBe('');
	});
});
