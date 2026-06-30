import { describe, it, expect } from 'vitest';
import { timingSafeStringEqual } from '../timingSafe.js';

describe('timingSafeStringEqual', () => {
	it('returns true for equal strings', () => {
		expect(timingSafeStringEqual('owlat_secret_key', 'owlat_secret_key')).toBe(true);
	});

	it('returns false for unequal strings of the same length', () => {
		expect(timingSafeStringEqual('owlat_secret_key', 'owlat_secret_kez')).toBe(false);
	});

	it('returns false for strings of different length', () => {
		expect(timingSafeStringEqual('short', 'a_much_longer_value')).toBe(false);
	});

	it('returns true for two empty strings', () => {
		expect(timingSafeStringEqual('', '')).toBe(true);
	});

	it('returns false when only one string is empty', () => {
		expect(timingSafeStringEqual('', 'nonempty')).toBe(false);
	});

	it('handles multi-byte UTF-8 correctly', () => {
		// "café" and "cafe" differ in byte length (é is 2 bytes), must not throw.
		expect(timingSafeStringEqual('café', 'cafe')).toBe(false);
		expect(timingSafeStringEqual('café', 'café')).toBe(true);
	});
});
