/**
 * The language rule for model-written copy shown to the Owlat user in their
 * interface language: catch-up cards, Today summaries, the classifier's
 * per-locale summaries and translated clarification questions.
 *
 * Besides naming the language it pins the register the product speaks in.
 * German copy addresses the user with informal lowercase "du"; without being
 * told, a model writes German instructions and questions in the formal "Sie".
 * English has no such choice, so it only gets the language name.
 *
 * Not for reply drafts to the other party: those follow the sender's language
 * and register (agent/shared/replyLanguage.ts).
 */

import { isAppLocale, type AppLocale } from '@owlat/shared/appLocales';

const LANGUAGE_NAMES: Record<AppLocale, string> = { en: 'English', de: 'German' };

/** How the product addresses its user in each interface language, when the language has a choice. */
const REGISTER_RULES: Partial<Record<AppLocale, string>> = {
	de:
		'Address the reader informally with lowercase "du" (dein, dir, dich) and use the du ' +
		'form for imperatives ("Bestätige den Termin", not "Bestätigen Sie den Termin"). ' +
		'Never address the reader as "Sie".',
};

/** The English name of an interface locale; anything unknown reads as English. */
export function interfaceLanguageName(locale: string): string {
	return isAppLocale(locale) ? LANGUAGE_NAMES[locale] : LANGUAGE_NAMES.en;
}

/** The register rule for one interface locale, or '' when the language has none. */
export function interfaceRegisterRule(locale: string): string {
	return isAppLocale(locale) ? (REGISTER_RULES[locale] ?? '') : '';
}

/**
 * The register rules for a prompt that writes several interface languages at
 * once, one line per language code that has a rule; '' when none has one.
 */
export function interfaceRegisterRules(locales: readonly string[]): string {
	return locales
		.map((locale) => {
			const rule = interfaceRegisterRule(locale);
			return rule ? `In "${locale}" (${interfaceLanguageName(locale)}): ${rule}` : '';
		})
		.filter(Boolean)
		.join('\n');
}
