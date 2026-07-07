/**
 * The long-thread eligibility predicate that gates the reader's AI strip: a
 * thread warrants a summary when it has many messages OR a lot of total body
 * text; a short back-and-forth does not.
 */
import { describe, it, expect } from 'vitest';

import { isLongThreadForSummary } from '../postboxAutoSummary';

describe('isLongThreadForSummary', () => {
	it('is true for a thread of >= 5 messages', () => {
		const msgs = Array.from({ length: 5 }, () => ({ snippet: 'hi' }));
		expect(isLongThreadForSummary(msgs)).toBe(true);
	});

	it('is false for a short thread with little body text', () => {
		const msgs = [{ textBodyInline: 'thanks' }, { textBodyInline: 'you too' }];
		expect(isLongThreadForSummary(msgs)).toBe(false);
	});

	it('is true for a short thread with a very long body', () => {
		const msgs = [{ textBodyInline: 'x'.repeat(9000) }];
		expect(isLongThreadForSummary(msgs)).toBe(true);
	});
});
