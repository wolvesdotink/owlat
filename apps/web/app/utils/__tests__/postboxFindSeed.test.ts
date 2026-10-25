/**
 * What a mail search hands find in conversation: the words, never an
 * operator, and nothing at all when the query has no words to find.
 */
import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '@owlat/shared/mailSearch';
import { postboxFindTermsOf } from '../postboxFindSeed';

const termsOf = (query: string) => postboxFindTermsOf(parseSearchQuery(query));

describe('postboxFindTermsOf', () => {
	it('keeps the free text and drops the operators around it', () => {
		expect(termsOf('from:ines@example.com refund is:unread')).toBe('refund');
		expect(termsOf('invoice 4471 before:2026-01-01')).toBe('invoice 4471');
	});

	it('prefers the first quoted phrase', () => {
		expect(termsOf('subject:billing "refund the duplicate" invoice')).toBe('refund the duplicate');
	});

	it('seeds nothing for a query made only of operators', () => {
		expect(termsOf('from:ines@example.com is:starred has:attachment')).toBeNull();
		expect(termsOf('')).toBeNull();
	});

	it('seeds nothing for an OR query: which side matched is unknown', () => {
		expect(termsOf('refund OR invoice')).toBeNull();
	});
});
