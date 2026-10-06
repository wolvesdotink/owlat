import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ runLlmObject: vi.fn() }));
vi.mock('../../lib/llm/dispatch', () => ({ runLlmObject: mocks.runLlmObject }));

import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import {
	buildLocalizePrompt,
	mergeTranslations,
	missingTranslationPairs,
	normalizeTargetLocale,
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

	it('asks for the informal "du" in German and nothing extra elsewhere', () => {
		const de = buildLocalizePrompt(questions, ['de']);
		expect(de).toContain('In "de" (German): Address the reader informally with lowercase "du"');
		expect(de.indexOf('lowercase "du"')).toBeLessThan(de.indexOf('Questions:'));
		expect(buildLocalizePrompt(questions, ['fr'])).not.toContain('"du"');
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

	it('drops unknown ids, unwanted locales and blank text', () => {
		const merged = mergeTranslations(
			questions,
			[
				{ questionId: 'nope', locale: 'de', text: 'x', options: [] },
				{ questionId: 'q0', locale: 'fr', text: 'x', options: ['Oui', 'Non'] },
				{ questionId: 'q0', locale: 'de', text: '   ', options: ['Ja', 'Nein'] },
			],
			['de']
		);
		expect(merged[0]?.translations).toBeUndefined();
		expect(merged[1]?.translations).toBeUndefined();
	});

	it('keeps the translated text when only the option count is wrong', () => {
		const merged = mergeTranslations(
			questions,
			[{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja'] }],
			['de']
		);
		// No `options`: the UI falls back to the canonical chips.
		expect(merged[0]?.translations).toEqual([{ locale: 'de', text: '45 Tage gewähren?' }]);
	});

	it('keeps the translated text when a translated chip is blank', () => {
		const merged = mergeTranslations(
			questions,
			[{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', ' '] }],
			['de']
		);
		expect(merged[0]?.translations).toEqual([{ locale: 'de', text: '45 Tage gewähren?' }]);
	});

	it('accepts region variants of a locale and quoted question ids', () => {
		const merged = mergeTranslations(
			questions,
			[
				{ questionId: '"q0"', locale: 'de-DE', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				{ questionId: ' q1 ', locale: 'de_de', text: 'Gibt es eine Gebühr?', options: [] },
			],
			['de']
		);
		expect(merged[0]?.translations).toEqual([
			{ locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
		]);
		expect(merged[1]?.translations).toEqual([{ locale: 'de', text: 'Gibt es eine Gebühr?' }]);
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

describe('normalizeTargetLocale', () => {
	it('maps codes, region variants and language names onto a wanted code', () => {
		expect(normalizeTargetLocale('de', ['de'])).toBe('de');
		expect(normalizeTargetLocale(' DE ', ['de'])).toBe('de');
		expect(normalizeTargetLocale('de-DE', ['de'])).toBe('de');
		expect(normalizeTargetLocale('de_de', ['de'])).toBe('de');
		expect(normalizeTargetLocale('German', ['de'])).toBe('de');
		expect(normalizeTargetLocale('Deutsch', ['de'])).toBe('de');
	});

	it('rejects locales that were not asked for', () => {
		expect(normalizeTargetLocale('fr', ['de'])).toBeUndefined();
		expect(normalizeTargetLocale('French', ['de'])).toBeUndefined();
		expect(normalizeTargetLocale('', ['de'])).toBeUndefined();
	});
});

describe('missingTranslationPairs', () => {
	it('lists every (question, locale) pair without a translation', () => {
		expect(
			missingTranslationPairs(
				[
					{ id: 'q0', text: 'a', translations: [{ locale: 'de', text: 'A' }] },
					{ id: 'q1', text: 'b' },
				],
				['de', 'fr']
			)
		).toEqual([
			{ questionId: 'q0', locale: 'fr' },
			{ questionId: 'q1', locale: 'de' },
			{ questionId: 'q1', locale: 'fr' },
		]);
	});
});

function objectResult(translations: unknown[], totalTokens = 10) {
	return {
		object: { translations },
		tokenUsage: { promptTokens: totalTokens / 2, completionTokens: totalTokens / 2, totalTokens },
		modelUsed: 'mock-model',
	};
}

describe('localizeQuestions', () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		mocks.runLlmObject.mockReset();
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it('makes one call when the first pass covers every question', async () => {
		mocks.runLlmObject.mockResolvedValueOnce(
			objectResult([
				{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				{ questionId: 'q1', locale: 'de', text: 'Gibt es eine Gebühr?', options: [] },
			])
		);
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(result.questions.every((q) => q.translations?.length === 1)).toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});

	it('retries once for just the missing question and merges the result', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(
				objectResult([
					{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				])
			)
			.mockResolvedValueOnce(
				objectResult(
					[
						{ questionId: 'q1', locale: 'de', text: 'Gibt es eine Gebühr?', options: [] },
						// A pair the first pass already filled is never overwritten.
						{ questionId: 'q0', locale: 'de', text: 'Andere Fassung', options: [] },
					],
					4
				)
			);
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
		const retryPrompt = mocks.runLlmObject.mock.calls[1]![0].prompt as string;
		expect(retryPrompt).toContain('id "q1"');
		expect(retryPrompt).not.toContain('id "q0"');
		expect(result.questions[0]?.translations).toEqual([
			{ locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
		]);
		expect(result.questions[1]?.translations).toEqual([
			{ locale: 'de', text: 'Gibt es eine Gebühr?' },
		]);
		expect(result.tokenUsage?.totalTokens).toBe(14);
		expect(warn).not.toHaveBeenCalled();
	});

	it('keeps the first pass and logs only a count when the retry fails', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(
				objectResult([
					{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				])
			)
			.mockRejectedValueOnce(new Error('model unavailable'));
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
		expect(result.questions[0]?.translations).toHaveLength(1);
		expect(result.questions[1]?.translations).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0]![0]);
		expect(line).toContain('1 of 2');
		expect(line).not.toContain('late fee');
	});

	it('returns the questions unchanged when the first call fails', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('model unavailable'));
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(result.questions).toEqual(questions);
	});

	it('reports the billed usage of a first call that failed the schema (#1260)', async () => {
		const billed = { promptTokens: 30, completionTokens: 15, totalTokens: 45 };
		mocks.runLlmObject.mockRejectedValueOnce(
			new LlmPartialUsageError(new Error('did not match schema'), billed, 'mock-model')
		);
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(result.questions).toEqual(questions);
		expect(result.tokenUsage).toEqual(billed);
		expect(result.modelUsed).toBe('mock-model');
	});

	it('adds the billed usage of a retry that failed the schema to the first pass', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(
				objectResult([
					{ questionId: 'q0', locale: 'de', text: '45 Tage gewähren?', options: ['Ja', 'Nein'] },
				])
			)
			.mockRejectedValueOnce(
				new LlmPartialUsageError(
					new Error('did not match schema'),
					{ promptTokens: 2, completionTokens: 2, totalTokens: 4 },
					'mock-model'
				)
			);
		const result = await localizeQuestions({} as never, questions, ['en', 'de']);
		expect(result.questions[1]?.translations).toBeUndefined();
		expect(result.tokenUsage?.totalTokens).toBe(14);
	});

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
