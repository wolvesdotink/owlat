/**
 * Message-ID canonicalisation (lib/messageId.ts): the one shape the
 * `rfc822MessageId` column is written in and every dedup read looks up.
 */

import { describe, it, expect } from 'vitest';
import { canonicalMessageId, canonicalOptionalMessageId } from '../messageId';

describe('canonicalMessageId', () => {
	it('strips the angle brackets', () => {
		expect(canonicalMessageId('<abc@example.com>')).toBe('abc@example.com');
	});

	it('leaves an already-bare id alone', () => {
		expect(canonicalMessageId('abc@example.com')).toBe('abc@example.com');
	});

	it('trims surrounding whitespace, inside and outside the brackets', () => {
		expect(canonicalMessageId('  < abc@example.com >\r\n')).toBe('abc@example.com');
	});

	it('falls back to the raw string when nothing is left', () => {
		expect(canonicalMessageId('')).toBe('');
		expect(canonicalMessageId('<>')).toBe('<>');
		expect(canonicalMessageId('   ')).toBe('   ');
	});
});

describe('canonicalOptionalMessageId', () => {
	it('canonicalises a present id the same way', () => {
		expect(canonicalOptionalMessageId('<abc@example.com>')).toBe('abc@example.com');
		expect(canonicalOptionalMessageId(' abc@example.com ')).toBe('abc@example.com');
	});

	it('returns undefined for absent, empty, blank or bracket-only input', () => {
		expect(canonicalOptionalMessageId(undefined)).toBeUndefined();
		expect(canonicalOptionalMessageId('')).toBeUndefined();
		expect(canonicalOptionalMessageId('   ')).toBeUndefined();
		expect(canonicalOptionalMessageId('<>')).toBeUndefined();
	});
});
