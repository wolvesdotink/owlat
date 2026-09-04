export interface LanguageOption {
	value: string;
	/**
	 * MESSAGE KEY for the language's English name — this catalog is module scope,
	 * so it carries keys, not copy. Every picker resolves it with `t()`.
	 */
	label: string;
	/** Endonym shown next to the English label (same as label for English). */
	nativeLabel: string;
}

/**
 * The single supported-language catalog. Three diverged copies of this list
 * once existed (the Translation Manager's had ASCII-mangled endonyms like
 * "Francais"); every language picker imports this one.
 */
export const languageOptions: LanguageOption[] = [
	{ value: 'en', label: 'shared.data.languageOptions.languages.en', nativeLabel: 'English' },
	{ value: 'de', label: 'shared.data.languageOptions.languages.de', nativeLabel: 'Deutsch' },
	{ value: 'fr', label: 'shared.data.languageOptions.languages.fr', nativeLabel: 'Français' },
	{ value: 'es', label: 'shared.data.languageOptions.languages.es', nativeLabel: 'Español' },
	{ value: 'it', label: 'shared.data.languageOptions.languages.it', nativeLabel: 'Italiano' },
	{ value: 'pt', label: 'shared.data.languageOptions.languages.pt', nativeLabel: 'Português' },
	{ value: 'nl', label: 'shared.data.languageOptions.languages.nl', nativeLabel: 'Nederlands' },
	{ value: 'pl', label: 'shared.data.languageOptions.languages.pl', nativeLabel: 'Polski' },
	{ value: 'ru', label: 'shared.data.languageOptions.languages.ru', nativeLabel: 'Русский' },
	{ value: 'ja', label: 'shared.data.languageOptions.languages.ja', nativeLabel: '日本語' },
	{ value: 'zh', label: 'shared.data.languageOptions.languages.zh', nativeLabel: '中文' },
	{ value: 'ko', label: 'shared.data.languageOptions.languages.ko', nativeLabel: '한국어' },
	{ value: 'ar', label: 'shared.data.languageOptions.languages.ar', nativeLabel: 'العربية' },
	{ value: 'hi', label: 'shared.data.languageOptions.languages.hi', nativeLabel: 'हिन्दी' },
	{ value: 'tr', label: 'shared.data.languageOptions.languages.tr', nativeLabel: 'Türkçe' },
	{ value: 'sv', label: 'shared.data.languageOptions.languages.sv', nativeLabel: 'Svenska' },
	{ value: 'da', label: 'shared.data.languageOptions.languages.da', nativeLabel: 'Dansk' },
	{ value: 'no', label: 'shared.data.languageOptions.languages.no', nativeLabel: 'Norsk' },
	{ value: 'fi', label: 'shared.data.languageOptions.languages.fi', nativeLabel: 'Suomi' },
];

/** "English (English)" reads silly — only parenthesize differing endonyms. */
export function formatLanguageLabel(opt: Pick<LanguageOption, 'label' | 'nativeLabel'>): string {
	return opt.label === opt.nativeLabel ? opt.label : `${opt.label} (${opt.nativeLabel})`;
}

/** Catalog variant for contact-level pickers where "unset" is a valid choice. */
const languageOptionsWithUnset: LanguageOption[] = [
	{
		value: '',
		label: 'shared.data.languageOptions.notSetEmailDefault',
		nativeLabel: 'shared.data.languageOptions.notSetEmailDefault',
	},
	...languageOptions,
];

/**
 * Language picker options as `{ value, label }` pairs, with the localized name
 * parenthesizing a differing endonym (e.g. "German (Deutsch)"). Single source
 * for contact-level language `<select>`s — replaces the hand-maintained copy
 * that had drifted (it once carried its own "German (Deutsch)" list that could
 * fall out of sync with the catalog).
 *
 * A FUNCTION, not a frozen array: the labels are words, so they can only be
 * built where a translator is in hand. Callers pass `t` from `useI18n()`.
 */
export function languageSelectOptions(
	translate: (key: string) => string
): { value: string; label: string }[] {
	return languageOptionsWithUnset.map((opt) => ({
		value: opt.value,
		label: formatLanguageLabel({
			label: translate(opt.label),
			nativeLabel: translate(opt.nativeLabel),
		}),
	}));
}

export interface TimezoneOption {
	value: string;
	/** MESSAGE KEY — module scope, so this catalog carries keys, not copy. */
	label: string;
}

/**
 * The single timezone catalog for contact-level pickers (value '' = "use the
 * campaign default"). Previously inlined in `useContactDetail`.
 */
export const timezoneOptions: TimezoneOption[] = [
	{ value: '', label: 'shared.data.languageOptions.notSetCampaignDefault' },
	{ value: 'America/New_York', label: 'shared.data.languageOptions.timezones.americaNewYork' },
	{ value: 'America/Chicago', label: 'shared.data.languageOptions.timezones.americaChicago' },
	{ value: 'America/Denver', label: 'shared.data.languageOptions.timezones.americaDenver' },
	{
		value: 'America/Los_Angeles',
		label: 'shared.data.languageOptions.timezones.americaLosAngeles',
	},
	{ value: 'America/Anchorage', label: 'shared.data.languageOptions.timezones.americaAnchorage' },
	{ value: 'Pacific/Honolulu', label: 'shared.data.languageOptions.timezones.pacificHonolulu' },
	{ value: 'Europe/London', label: 'shared.data.languageOptions.timezones.europeLondon' },
	{ value: 'Europe/Paris', label: 'shared.data.languageOptions.timezones.europeParis' },
	{ value: 'Europe/Berlin', label: 'shared.data.languageOptions.timezones.europeBerlin' },
	{ value: 'Europe/Amsterdam', label: 'shared.data.languageOptions.timezones.europeAmsterdam' },
	{ value: 'Asia/Tokyo', label: 'shared.data.languageOptions.timezones.asiaTokyo' },
	{ value: 'Asia/Shanghai', label: 'shared.data.languageOptions.timezones.asiaShanghai' },
	{ value: 'Asia/Singapore', label: 'shared.data.languageOptions.timezones.asiaSingapore' },
	{ value: 'Asia/Dubai', label: 'shared.data.languageOptions.timezones.asiaDubai' },
	{ value: 'Asia/Kolkata', label: 'shared.data.languageOptions.timezones.asiaKolkata' },
	{ value: 'Australia/Sydney', label: 'shared.data.languageOptions.timezones.australiaSydney' },
	{
		value: 'Australia/Melbourne',
		label: 'shared.data.languageOptions.timezones.australiaMelbourne',
	},
	{ value: 'Pacific/Auckland', label: 'shared.data.languageOptions.timezones.pacificAuckland' },
];
