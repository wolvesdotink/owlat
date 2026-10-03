import { describe, it, expect } from 'vitest';
import {
	attributionDomain,
	canonicalOption,
	clarificationTrust,
	localizedQuestionCopy,
	localizedSummary,
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

describe('attributionDomain', () => {
	it('reads the sender domain out of the server attribution line', () => {
		expect(
			attributionDomain(
				'Generated from an email from acme.com — Owlat will never ask for your password.'
			)
		).toBe('acme.com');
		expect(attributionDomain('Generated from an email from acme.com.')).toBe('acme.com');
	});

	it('is null when the line names no domain, or there is no line', () => {
		expect(
			attributionDomain('Generated from an email — Owlat will never ask for your password.')
		).toBeNull();
		expect(attributionDomain(undefined)).toBeNull();
	});
});

describe('clarificationTrust', () => {
	const legacy = (domain?: string) =>
		`Generated from ${domain ? `an email from ${domain}` : 'an email'} — Owlat will never ask for your password.`;

	it('names the domain from the stored origin, not the English sentence', () => {
		expect(
			clarificationTrust([
				{
					attribution: legacy('stale.example'),
					origin: { kind: 'email', senderDomain: 'acme.com' },
				},
			])
		).toEqual({ domain: 'acme.com' });
	});

	it('names no domain when the origin has none, even if the sentence does', () => {
		expect(
			clarificationTrust([{ attribution: legacy('acme.com'), origin: { kind: 'email' } }])
		).toEqual({ domain: null });
	});

	it('reads the domain out of the legacy sentence for questions stored before origin', () => {
		expect(clarificationTrust([{ attribution: legacy('acme.com') }])).toEqual({
			domain: 'acme.com',
		});
		expect(clarificationTrust([{ attribution: legacy() }])).toEqual({ domain: null });
	});

	it('names one domain only when every question agrees', () => {
		expect(
			clarificationTrust([
				{ origin: { kind: 'email', senderDomain: 'acme.com' } },
				{ attribution: legacy('acme.com') },
			])
		).toEqual({ domain: 'acme.com' });
		expect(
			clarificationTrust([
				{ origin: { kind: 'email', senderDomain: 'acme.com' } },
				{ origin: { kind: 'email', senderDomain: 'other.example' } },
			])
		).toEqual({ domain: null });
	});

	it('is null when no question says where it came from', () => {
		expect(clarificationTrust([{}, { attribution: '' }])).toBeNull();
		expect(clarificationTrust([])).toBeNull();
	});
});
