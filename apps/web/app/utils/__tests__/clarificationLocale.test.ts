import { describe, it, expect } from 'vitest';
import { canonicalOption, localizedQuestionCopy, localizedSummary } from '../clarificationLocale';

/**
 * The reader sees a clarification question in their own language; the answer
 * they submit is always the canonical English option. These pin the fallback
 * rule (locale entry → canonical) and the chip-to-canonical mapping.
 */
const question = {
	text: 'Grant the 45-day terms?',
	options: ['Yes', 'No'],
	translations: [{ locale: 'de', text: '45-Tage-Zahlungsziel gewähren?', options: ['Ja', 'Nein'] }],
};

describe('localizedQuestionCopy', () => {
	it('renders the entry for the current locale', () => {
		expect(localizedQuestionCopy(question, 'de')).toEqual({
			text: '45-Tage-Zahlungsziel gewähren?',
			options: ['Ja', 'Nein'],
		});
	});

	it('falls back to the canonical copy for a locale with no entry', () => {
		expect(localizedQuestionCopy(question, 'fr')).toEqual({
			text: 'Grant the 45-day terms?',
			options: ['Yes', 'No'],
		});
		expect(localizedQuestionCopy({ text: 'Late fee?' }, 'de')).toEqual({
			text: 'Late fee?',
			options: [],
		});
	});

	it('keeps canonical options when a translation lost some', () => {
		const partial = {
			...question,
			translations: [{ locale: 'de', text: 'Gewähren?', options: ['Ja'] }],
		};
		expect(localizedQuestionCopy(partial, 'de').options).toEqual(['Yes', 'No']);
	});
});

describe('canonicalOption', () => {
	it('maps a displayed translated chip back to the canonical value', () => {
		expect(canonicalOption(question, 'de', 'Nein')).toBe('No');
	});

	it('passes free text and canonical values through unchanged', () => {
		expect(canonicalOption(question, 'de', 'Only for one invoice')).toBe('Only for one invoice');
		expect(canonicalOption(question, 'en', 'Yes')).toBe('Yes');
	});
});

describe('localizedSummary', () => {
	it('prefers the locale, then English, then anything', () => {
		expect(localizedSummary({ en: 'E', de: 'D' }, 'de')).toBe('D');
		expect(localizedSummary({ en: 'E', de: 'D' }, 'fr')).toBe('E');
		expect(localizedSummary({ de: 'D' }, 'fr')).toBe('D');
		expect(localizedSummary(undefined, 'de')).toBeUndefined();
	});
});
