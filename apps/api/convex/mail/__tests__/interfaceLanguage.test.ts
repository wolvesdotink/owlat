import { describe, expect, it } from 'vitest';
import {
	interfaceLanguageName,
	interfaceRegisterRule,
	interfaceRegisterRules,
} from '../ai/interfaceLanguage';

describe('interface language', () => {
	it('names every shipped locale and reads anything else as English', () => {
		expect(interfaceLanguageName('en')).toBe('English');
		expect(interfaceLanguageName('de')).toBe('German');
		expect(interfaceLanguageName('fr')).toBe('English');
		expect(interfaceLanguageName('')).toBe('English');
	});

	it('pins German to the informal lowercase "du"', () => {
		const rule = interfaceRegisterRule('de');
		expect(rule).toContain('lowercase "du"');
		expect(rule).toContain('"Bestätige den Termin"');
		expect(rule).toContain('Never address the reader as "Sie"');
	});

	it('adds nothing for a language without a register choice', () => {
		expect(interfaceRegisterRule('en')).toBe('');
		expect(interfaceRegisterRule('fr')).toBe('');
	});

	it('lists one rule per locale that has one', () => {
		expect(interfaceRegisterRules(['en', 'de'])).toBe(
			`In "de" (German): ${interfaceRegisterRule('de')}`
		);
		expect(interfaceRegisterRules(['en'])).toBe('');
		expect(interfaceRegisterRules([])).toBe('');
	});
});
