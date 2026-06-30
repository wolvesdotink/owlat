import { describe, it, expect } from 'vitest';
import { buildVerpAddress, parseVerpAddress } from '../bounce/verp.js';

describe('VERP encoding/decoding', () => {
	const domain = 'bounces.owlat.com';

	it('should roundtrip a simple messageId', () => {
		const messageId = 'msg-123-abc';
		const verp = buildVerpAddress(messageId, domain);
		expect(parseVerpAddress(verp)).toBe(messageId);
	});

	it('should roundtrip a UUID messageId', () => {
		const messageId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		const verp = buildVerpAddress(messageId, domain);
		expect(parseVerpAddress(verp)).toBe(messageId);
	});

	it('should roundtrip messageIds with special characters', () => {
		const messageId = 'msg/with+special=chars';
		const verp = buildVerpAddress(messageId, domain);
		expect(parseVerpAddress(verp)).toBe(messageId);
	});

	it('should produce a valid email address format', () => {
		const verp = buildVerpAddress('test-id', domain);
		expect(verp).toMatch(/^bounce\+[A-Za-z0-9_-]+@bounces\.owlat\.com$/);
	});

	it('should return null for non-VERP addresses', () => {
		expect(parseVerpAddress('user@example.com')).toBeNull();
		expect(parseVerpAddress('noreply@owlat.com')).toBeNull();
		expect(parseVerpAddress('')).toBeNull();
	});

	it('should return null for malformed VERP addresses', () => {
		expect(parseVerpAddress('bounce+@domain.com')).toBeNull();
		expect(parseVerpAddress('bounce+!!!@domain.com')).toBeNull();
	});

	it('should return null for empty messageId (empty base64url)', () => {
		// Empty messageId produces "bounce+@domain" which is not a valid VERP address
		const verp = buildVerpAddress('', domain);
		expect(parseVerpAddress(verp)).toBeNull();
	});

	it('should handle unicode messageId', () => {
		const messageId = 'msg-日本語-test';
		const verp = buildVerpAddress(messageId, domain);
		expect(parseVerpAddress(verp)).toBe(messageId);
	});
});
