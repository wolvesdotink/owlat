/**
 * Unit test for the handling-rule compile PROMPT (pure). The live compile action
 * (network) is not exercised here; the integration test feeds pre-compiled rules.
 */

import { describe, it, expect } from 'vitest';
import { buildCompilePrompt } from '../handlingRulesCompile';

describe('buildCompilePrompt', () => {
	it('embeds the user rule verbatim and names every action type', () => {
		const prompt = buildCompilePrompt('always decline cold recruiter pitches');
		expect(prompt).toContain('always decline cold recruiter pitches');
		for (const action of [
			'draft_with_stance',
			'categorize',
			'auto_archive',
			'always_ask',
			'never_auto_send',
		]) {
			expect(prompt).toContain(action);
		}
	});

	it('requires at least one matcher facet', () => {
		const prompt = buildCompilePrompt('flag anything from legal');
		expect(prompt.toLowerCase()).toContain('at least one facet');
	});
});
