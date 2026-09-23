import { describe, expect, it } from 'vitest';
import { cleanTodaySentence, todaySummaryPrompt, TODAY_SENTENCE_MAX } from '../summaryPrompt';

describe('today summary prompt', () => {
	it('frames the email as untrusted data and asks in the reader language', () => {
		const { system, prompt } = todaySummaryPrompt({
			guard: 'GUARD.',
			locale: 'de',
			isFollowUp: true,
			earlier: 'old',
			latest: 'new',
		});
		expect(system.startsWith('GUARD.')).toBe(true);
		expect(system).toContain('German');
		expect(system).toContain('what changed');
		expect(prompt).toContain('# What the reader already saw (untrusted data)\nold');
		expect(prompt).toContain('# New since then (untrusted data)\nnew');
	});

	it('keeps one clean sentence out of whatever the model returns', () => {
		expect(cleanTodaySentence('- Harbor Design sent the files.\n- Also a logo.')).toBe(
			'Harbor Design sent the files.'
		);
		expect(cleanTodaySentence('"Stripe paid out €3,420."')).toBe('Stripe paid out €3,420.');
		expect(cleanTodaySentence('   ')).toBe('');
		expect(cleanTodaySentence('3 new orders came in from Brightpath.')).toBe(
			'3 new orders came in from Brightpath.'
		);
		expect(cleanTodaySentence('1. Harbor Design sent the files.')).toBe(
			'Harbor Design sent the files.'
		);
		const long = cleanTodaySentence('word '.repeat(80));
		expect(long.length).toBeLessThanOrEqual(TODAY_SENTENCE_MAX + 1);
		expect(long.endsWith('…')).toBe(true);
	});
});
