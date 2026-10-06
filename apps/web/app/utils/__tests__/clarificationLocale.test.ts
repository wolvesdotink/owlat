import { describe, it, expect } from 'vitest';
import {
	canonicalOption,
	clarificationTrust,
	localizedQuestionCopy,
	localizedSummary,
	type ClarificationProvenance,
} from '../clarificationLocale';

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

describe('clarificationTrust', () => {
	const from = (senderDomain?: string) =>
		senderDomain ? { kind: 'email' as const, senderDomain } : { kind: 'email' as const };

	it('names the domain from the stored origin', () => {
		expect(clarificationTrust([{ origin: from('acme.com') }])).toEqual({ domain: 'acme.com' });
	});

	it('names no domain when the origin has none', () => {
		expect(clarificationTrust([{ origin: from() }])).toEqual({ domain: null });
	});

	it('reads `origin` alone and ignores a legacy sentence (#1224)', () => {
		// Before #1224 a question without `origin` fell back to the domain in
		// its English `attribution` sentence. The schema no longer has the field.
		const legacy: ClarificationProvenance & { attribution: string } = {
			attribution:
				'Generated from an email from acme.com — Owlat will never ask for your password.',
		};
		expect(clarificationTrust([legacy])).toBeNull();
		expect(clarificationTrust([{ ...legacy, origin: from('other.example') }])).toEqual({
			domain: 'other.example',
		});
	});

	it('names one domain only when every question agrees', () => {
		expect(
			clarificationTrust([{ origin: from('acme.com') }, { origin: from('acme.com') }])
		).toEqual({ domain: 'acme.com' });
		expect(
			clarificationTrust([{ origin: from('acme.com') }, { origin: from('other.example') }])
		).toEqual({ domain: null });
		expect(clarificationTrust([{ origin: from('acme.com') }, { origin: from() }])).toEqual({
			domain: null,
		});
	});

	it('skips questions without an origin and is null when none has one', () => {
		expect(clarificationTrust([{}, { origin: from('acme.com') }])).toEqual({
			domain: 'acme.com',
		});
		expect(clarificationTrust([{}, {}])).toBeNull();
		expect(clarificationTrust([])).toBeNull();
	});
});
