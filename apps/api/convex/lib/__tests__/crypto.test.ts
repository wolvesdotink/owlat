/**
 * Unit tests for the backend's one constant-time compare and one HMAC.
 *
 * Correctness, not timing, is what is verifiable here; the timing property is a
 * structural argument about the loop body running the same number of times
 * whatever the inputs are.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual, hmacSignature, secretMatches } from '../crypto';
import * as security from '../../webhooks/security';

describe('constantTimeEqual', () => {
	it('returns true for identical strings', () => {
		expect(constantTimeEqual('hello-world', 'hello-world')).toBe(true);
	});

	it('returns false when content differs (same length)', () => {
		expect(constantTimeEqual('hello-world', 'hello-WORLD')).toBe(false);
	});

	it('returns false for different lengths', () => {
		expect(constantTimeEqual('short', 'much-longer-string')).toBe(false);
	});

	it('returns true for two empty strings', () => {
		expect(constantTimeEqual('', '')).toBe(true);
	});

	it('returns false when one side is empty', () => {
		expect(constantTimeEqual('', 'x')).toBe(false);
		expect(constantTimeEqual('x', '')).toBe(false);
	});

	it('handles unicode safely (per-code-unit compare)', () => {
		expect(constantTimeEqual('café', 'café')).toBe(true);
		expect(constantTimeEqual('café', 'cafe')).toBe(false);
	});

	it('is length-order-independent (single path, no length oracle)', () => {
		expect(constantTimeEqual('short', 'much-longer-string')).toBe(
			constantTimeEqual('much-longer-string', 'short')
		);
		expect(constantTimeEqual('a', 'ab')).toBe(false);
		expect(constantTimeEqual('ab', 'a')).toBe(false);
		// A prefix of the longer value still fails: the trailing units XOR against
		// 0 and the folded length difference keeps the accumulator non-zero.
		expect(constantTimeEqual('secret', 'secretX')).toBe(false);
		expect(constantTimeEqual('secretX', 'secret')).toBe(false);
	});
});

describe('secretMatches', () => {
	it('accepts the configured secret', () => {
		expect(secretMatches('instance-secret', 'instance-secret')).toBe(true);
	});

	it('rejects a wrong or truncated secret', () => {
		expect(secretMatches('instance-secreT', 'instance-secret')).toBe(false);
		expect(secretMatches('instance-secre', 'instance-secret')).toBe(false);
	});

	it('fails closed on an empty or missing value on either side', () => {
		expect(secretMatches('', '')).toBe(false);
		expect(secretMatches('x', '')).toBe(false);
		expect(secretMatches('x', undefined)).toBe(false);
		expect(secretMatches('', 'x')).toBe(false);
		expect(secretMatches(null, 'x')).toBe(false);
		expect(secretMatches(undefined, undefined)).toBe(false);
	});
});

describe('hmacSignature', () => {
	it('matches node:crypto for every algorithm and encoding', async () => {
		for (const algorithm of ['sha256', 'sha1'] as const) {
			for (const encoding of ['hex', 'base64', 'base64url'] as const) {
				expect(await hmacSignature('k', 'data', algorithm, encoding)).toBe(
					createHmac(algorithm, 'k').update('data').digest(encoding)
				);
			}
		}
	});
});

describe('webhooks/security re-exports', () => {
	it('re-exports the same primitives rather than keeping a second copy', () => {
		expect(security.constantTimeEqual).toBe(constantTimeEqual);
		expect(security.hmacSignature).toBe(hmacSignature);
	});
});
