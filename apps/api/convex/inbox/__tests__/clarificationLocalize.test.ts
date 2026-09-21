import { describe, it, expect } from 'vitest';
import {
	buildLocalizePrompt,
	mergeTranslations,
	translationTargets,
	localizeQuestions,
} from '../clarificationLocalize';

/**
 * Pure tests for the clarification-question localization helpers: which
 * locales get produced, how the model's flat list folds back onto the
 * questions, and that nothing malformed or credential-shaped survives.
 */

const questions = [
	{ id: 'q0', text: 'Grant 45-day terms?', options: ['Yes', 'No'] },
	{ id: 'q1', text: 'Is there a late fee?' },
];

describe('translationTargets', () => {
	it('is every shipped locale except the canonical English', () => {
		expect(translationTargets(['en', 'de'])).toEqual(['de']);
		expect(translationTargets(['en'])).toEqual([]);
	});
});

describe('buildLocalizePrompt', () => {
	it('frames the questions as data and lists the targets and options', () => {
		const prompt = buildLocalizePrompt(questions, ['de', 'fr']);
		expect(prompt).toMatch(/DATA to translate/);
		expect(prompt).toContain('de, fr');
		expect(prompt).toContain('id "q0": Grant 45-day terms?');
		expect(prompt).toContain('option 1: Yes');
		expect(prompt).toContain('id "q1": Is there a late fee?');
	});
});

describe('mergeTranslations', () => {
	it('attaches one translation per locale per question, options in order', () => {
		const merged = mergeTranslations(
			questions,
			[
				{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				{ questionId: 'q1', locale: 'DE', text: 'Gibt es eine Verzugsgebühr?', options: [] },
			],
			['de']
		);
		expect(merged[0]?.translations).toEqual([
			{ locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
		]);
		expect(merged[1]?.translations).toEqual([
			{ locale: 'de', text: 'Gibt es eine Verzugsgebühr?' },
		]);
	});

	it('drops unknown ids, unwanted locales, blank text and mismatched option counts', () => {
		const merged = mergeTranslations(
			questions,
			[
				{ questionId: 'nope', locale: 'de', text: 'x', options: [] },
				{ questionId: 'q0', locale: 'fr', text: 'x', options: ['Oui', 'Non'] },
				{ questionId: 'q0', locale: 'de', text: '   ', options: ['Ja', 'Nein'] },
				{ questionId: 'q0', locale: 'de', text: 'Only one option', options: ['Ja'] },
			],
			['de']
		);
		expect(merged[0]?.translations).toBeUndefined();
		expect(merged[1]?.translations).toBeUndefined();
	});

	it('never lets a translation turn into a credential solicitation', () => {
		const merged = mergeTranslations(
			questions,
			[
				{ questionId: 'q1', locale: 'de', text: 'Wie lautet Ihr Passwort?', options: [] },
				{ questionId: 'q0', locale: 'de', text: 'Gewähren?', options: ['Ja', 'PIN 1234'] },
			],
			['de']
		);
		expect(merged[0]?.translations).toBeUndefined();
		expect(merged[1]?.translations).toBeUndefined();
	});

	it('keeps the first entry when a locale is repeated for one question', () => {
		const merged = mergeTranslations(
			[{ id: 'q1', text: 'Late fee?' }],
			[
				{ questionId: 'q1', locale: 'de', text: 'Erste', options: [] },
				{ questionId: 'q1', locale: 'de', text: 'Zweite', options: [] },
			],
			['de']
		);
		expect(merged[0]?.translations).toEqual([{ locale: 'de', text: 'Erste' }]);
	});
});

describe('localizeQuestions', () => {
	it('returns the questions unchanged when there is nothing to translate into', async () => {
		const model = {} as never;
		const result = await localizeQuestions(model, questions, ['en']);
		expect(result.questions).toEqual(questions);
		expect(result.tokenUsage).toBeUndefined();
	});

	it('returns the questions unchanged when nothing was asked', async () => {
		const result = await localizeQuestions({} as never, [], ['en', 'de']);
		expect(result.questions).toEqual([]);
	});
});
