/**
 * Rule-suggestion copy registry (idea 27). The registry carries message KEYS,
 * not sentences, so the strip resolves them at the render boundary; a verb the
 * server does not offer must resolve to nothing rather than a half-rendered
 * offer with a missing key where its label should be.
 */
import { describe, it, expect } from 'vitest';
import { postboxFilterRuleLink, postboxTriageVerbCopy } from '../postboxTriageSuggestion';

describe('postboxTriageVerbCopy', () => {
	it('carries message keys for every verb the server can offer', () => {
		for (const verb of ['archive', 'trash', 'spam'] as const) {
			const copy = postboxTriageVerbCopy(verb);
			expect(copy).not.toBeNull();
			expect(copy?.promptKey).toContain('postboxTriageSuggestion.prompt.');
			expect(copy?.acceptKey).toContain('postboxTriageSuggestion.accept.');
			expect(copy?.ruleNameKey).toContain('postboxTriageSuggestion.ruleName.');
		}
	});

	it('resolves an unknown verb to nothing at all', () => {
		expect(postboxTriageVerbCopy('markRead')).toBeNull();
		expect(postboxTriageVerbCopy('')).toBeNull();
	});
});

describe('postboxFilterRuleLink', () => {
	it('deep-links the created rule into the Filters page', () => {
		expect(postboxFilterRuleLink('abc123')).toBe(
			'/dashboard/preferences/filters?openFilter=abc123'
		);
	});

	it('escapes the id rather than splicing it into the query raw', () => {
		expect(postboxFilterRuleLink('a&b=c')).toBe(
			'/dashboard/preferences/filters?openFilter=a%26b%3Dc'
		);
	});
});
