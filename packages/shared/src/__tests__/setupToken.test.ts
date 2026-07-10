import { describe, it, expect } from 'vitest';
import { generateSetupToken, isValidSetupToken } from '../setupToken';

describe('generateSetupToken', () => {
	it('mints a prefixed, high-entropy token', () => {
		const token = generateSetupToken();
		expect(token).toMatch(/^stk_[A-Za-z0-9]{40}$/);
	});

	it('gives each call a distinct token', () => {
		expect(generateSetupToken()).not.toBe(generateSetupToken());
	});
});

describe('isValidSetupToken', () => {
	const expected = generateSetupToken();

	it('accepts the correct token', () => {
		expect(isValidSetupToken(expected, expected)).toBe(true);
	});

	it('rejects a wrong token of the same length', () => {
		const wrong = generateSetupToken();
		expect(isValidSetupToken(wrong, expected)).toBe(false);
	});

	it('rejects a token that differs only in the last character', () => {
		const tampered = expected.slice(0, -1) + (expected.endsWith('A') ? 'B' : 'A');
		expect(isValidSetupToken(tampered, expected)).toBe(false);
	});

	it('rejects a missing provided token (fails closed)', () => {
		expect(isValidSetupToken(undefined, expected)).toBe(false);
		expect(isValidSetupToken(null, expected)).toBe(false);
		expect(isValidSetupToken('', expected)).toBe(false);
	});

	it('rejects when no token is configured (fails closed)', () => {
		expect(isValidSetupToken(expected, undefined)).toBe(false);
		expect(isValidSetupToken(expected, null)).toBe(false);
		expect(isValidSetupToken(expected, '')).toBe(false);
	});
});
