import { describe, expect, it } from 'vitest';
import { constantTimeEqual, secretMatches } from '../constantTimeEqual';

describe('constantTimeEqual', () => {
	it('accepts equal strings', () => {
		expect(constantTimeEqual('owlat_secret_key', 'owlat_secret_key')).toBe(true);
	});

	it('rejects unequal strings of the same length', () => {
		expect(constantTimeEqual('owlat_secret_key', 'owlat_secret_kez')).toBe(false);
	});

	it('rejects strings of different lengths without throwing', () => {
		expect(constantTimeEqual('short', 'a_much_longer_value')).toBe(false);
		expect(constantTimeEqual('owlat_secret_key', 'owlat_secret_ke')).toBe(false);
	});

	it('treats two empty values as equal and empty against non-empty as unequal', () => {
		expect(constantTimeEqual('', '')).toBe(true);
		expect(constantTimeEqual('', 'nonempty')).toBe(false);
	});

	it('compares multi-byte strings by their UTF-8 bytes', () => {
		expect(constantTimeEqual('café', 'cafe')).toBe(false);
		expect(constantTimeEqual('café', 'café')).toBe(true);
	});

	it('compares byte arrays, including different lengths', () => {
		const a = Uint8Array.from([1, 2, 3, 4]);
		expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3, 4]))).toBe(true);
		expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3, 5]))).toBe(false);
		expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3]))).toBe(false);
	});
});

describe('secretMatches', () => {
	it('accepts the configured secret', () => {
		expect(secretMatches('s3cret-value', 's3cret-value')).toBe(true);
	});

	it('rejects a wrong or truncated secret', () => {
		expect(secretMatches('s3cret-valuf', 's3cret-value')).toBe(false);
		expect(secretMatches('s3cret-valu', 's3cret-value')).toBe(false);
	});

	it('fails closed when the expected secret is empty or missing', () => {
		expect(secretMatches('', '')).toBe(false);
		expect(secretMatches('anything', '')).toBe(false);
		expect(secretMatches('anything', undefined)).toBe(false);
		expect(secretMatches('anything', null)).toBe(false);
	});

	it('fails closed when the presented value is empty or missing', () => {
		expect(secretMatches('', 's3cret-value')).toBe(false);
		expect(secretMatches(undefined, 's3cret-value')).toBe(false);
		expect(secretMatches(null, 's3cret-value')).toBe(false);
	});
});
