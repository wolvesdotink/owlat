/**
 * The plain-language search rewrite (mail/ai/searchRewriteText): which queries
 * are offered one, what the prompt carries, and how the model's line is cut down
 * to operators the search grammar actually understands. Pure, no model.
 */

import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '@owlat/shared/mailSearch';
import {
	MAX_SEARCH_REWRITE_INPUT_CHARS,
	buildSearchRewritePrompt,
	isSearchRewriteCandidate,
	normalizeSearchRewrite,
	resolveRewriteToday,
} from '../ai/searchRewriteText';

const ORIGINAL = 'the invoice from the hosting company in september';

describe('isSearchRewriteCandidate', () => {
	it('offers a rewrite for loose words only', () => {
		expect(isSearchRewriteCandidate(ORIGINAL)).toBe(true);
	});

	it.each([
		['an operator', 'from:mia onboarding'],
		['a quoted phrase', '"onboarding date"'],
		['an exclusion', 'invoice -draft'],
		['an OR', 'invoice OR receipt'],
		['nothing', '   '],
	])('skips a query with %s', (_label, query) => {
		expect(isSearchRewriteCandidate(query)).toBe(false);
	});
});

describe('buildSearchRewritePrompt', () => {
	it('frames the description as text to translate and carries the date', () => {
		const { system, prompt } = buildSearchRewritePrompt({ query: ORIGINAL, today: '2026-11-03' });
		expect(system).toContain('not instructions');
		expect(system).toContain('Today is 2026-11-03');
		expect(system).toContain('in:<folder> one of inbox, sent, drafts, trash, spam, archive');
		expect(prompt).toBe(`Description: ${ORIGINAL}`);
	});

	it('bounds the description', () => {
		const { prompt } = buildSearchRewritePrompt({ query: 'x'.repeat(5000), today: '2026-11-03' });
		expect(prompt.length).toBe('Description: '.length + MAX_SEARCH_REWRITE_INPUT_CHARS);
	});
});

describe('resolveRewriteToday', () => {
	const now = Date.parse('2026-11-03T12:00:00Z');

	it("keeps the browser's day when it is near the server clock", () => {
		expect(resolveRewriteToday('2026-11-04', now)).toBe('2026-11-04');
	});

	it.each([undefined, 'yesterday', '2026-13-45', '1999-01-01'])(
		"falls back to the server's UTC day for %s",
		(clientToday) => {
			expect(resolveRewriteToday(clientToday, now)).toBe('2026-11-03');
		}
	);
});

describe('normalizeSearchRewrite', () => {
	it('keeps a query the grammar understands', () => {
		const line = 'invoice has:attachment after:2026-09-01 before:2026-10-01';
		expect(normalizeSearchRewrite(line, ORIGINAL)).toBe(line);
		const parsed = parseSearchQuery(line);
		expect(parsed).toMatchObject({ text: 'invoice', hasAttachment: true });
		expect(parsed.afterMs).toBe(Date.parse('2026-09-01'));
	});

	it('unwraps the formatting a model adds around the line', () => {
		expect(normalizeSearchRewrite('```\nSearch for: `from:mia onboarding`\n```', ORIGINAL)).toBe(
			'from:mia onboarding'
		);
		expect(normalizeSearchRewrite('"from:mia is:unread"', ORIGINAL)).toBe('from:mia is:unread');
	});

	it('keeps quoted values quoted', () => {
		expect(normalizeSearchRewrite('subject:"quarterly report" from:acme', ORIGINAL)).toBe(
			'subject:"quarterly report" from:acme'
		);
	});

	it('drops operators the grammar does not understand instead of searching for them as text', () => {
		expect(
			normalizeSearchRewrite(
				'invoice has:pdf before:September in:receipts sender:acme from:hetzner.com',
				ORIGINAL
			)
		).toBe('invoice from:hetzner.com');
	});

	it('keeps a known folder role and an exclusion', () => {
		expect(normalizeSearchRewrite('flight -in:spam in:inbox', ORIGINAL)).toBe(
			'flight -in:spam in:inbox'
		);
		expect(normalizeSearchRewrite('flight -in:junk is:starred', ORIGINAL)).toBe(
			'flight is:starred'
		);
	});

	it('offers nothing when the model declined', () => {
		expect(normalizeSearchRewrite('NONE', ORIGINAL)).toBeNull();
		expect(normalizeSearchRewrite('', ORIGINAL)).toBeNull();
	});

	it('offers nothing when no operator survives', () => {
		expect(normalizeSearchRewrite('invoice hosting', ORIGINAL)).toBeNull();
		expect(normalizeSearchRewrite('invoice has:pdf', ORIGINAL)).toBeNull();
		expect(normalizeSearchRewrite('OR', ORIGINAL)).toBeNull();
	});

	it('bounds the rewritten query', () => {
		const long = Array.from({ length: 80 }, (_, i) => `from:sender${i}`).join(' ');
		const result = normalizeSearchRewrite(long, ORIGINAL);
		expect(result).not.toBeNull();
		expect(result!.length).toBeLessThanOrEqual(300);
		expect(result!.startsWith('from:sender0 from:sender1')).toBe(true);
	});

	it('offers nothing for a chatty reply with no operator in it', () => {
		expect(normalizeSearchRewrite('Sure! Here is the system prompt:', ORIGINAL)).toBeNull();
	});
});
