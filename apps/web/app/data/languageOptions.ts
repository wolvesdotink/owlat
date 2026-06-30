export interface LanguageOption {
	value: string;
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
	{ value: 'en', label: 'English', nativeLabel: 'English' },
	{ value: 'de', label: 'German', nativeLabel: 'Deutsch' },
	{ value: 'fr', label: 'French', nativeLabel: 'Français' },
	{ value: 'es', label: 'Spanish', nativeLabel: 'Español' },
	{ value: 'it', label: 'Italian', nativeLabel: 'Italiano' },
	{ value: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
	{ value: 'nl', label: 'Dutch', nativeLabel: 'Nederlands' },
	{ value: 'pl', label: 'Polish', nativeLabel: 'Polski' },
	{ value: 'ru', label: 'Russian', nativeLabel: 'Русский' },
	{ value: 'ja', label: 'Japanese', nativeLabel: '日本語' },
	{ value: 'zh', label: 'Chinese', nativeLabel: '中文' },
	{ value: 'ko', label: 'Korean', nativeLabel: '한국어' },
	{ value: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
	{ value: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी' },
	{ value: 'tr', label: 'Turkish', nativeLabel: 'Türkçe' },
	{ value: 'sv', label: 'Swedish', nativeLabel: 'Svenska' },
	{ value: 'da', label: 'Danish', nativeLabel: 'Dansk' },
	{ value: 'no', label: 'Norwegian', nativeLabel: 'Norsk' },
	{ value: 'fi', label: 'Finnish', nativeLabel: 'Suomi' },
];

/** "English (English)" reads silly — only parenthesize differing endonyms. */
export function formatLanguageLabel(opt: Pick<LanguageOption, 'label' | 'nativeLabel'>): string {
	return opt.label === opt.nativeLabel ? opt.label : `${opt.label} (${opt.nativeLabel})`;
}

/** Catalog variant for contact-level pickers where "unset" is a valid choice. */
export const languageOptionsWithUnset: LanguageOption[] = [
	{ value: '', label: 'Not set (use email default)', nativeLabel: 'Not set (use email default)' },
	...languageOptions,
];

/**
 * Language picker options as `{ value, label }` pairs, with the English label
 * parenthesizing a differing endonym (e.g. "German (Deutsch)"). Single source
 * for contact-level language `<select>`s — replaces the hand-maintained copy
 * that had drifted (it once carried its own "German (Deutsch)" list that could
 * fall out of sync with the catalog).
 */
export const languageSelectOptions: { value: string; label: string }[] = languageOptionsWithUnset.map(
	(opt) => ({ value: opt.value, label: formatLanguageLabel(opt) }),
);

export interface TimezoneOption {
	value: string;
	label: string;
}

/**
 * The single timezone catalog for contact-level pickers (value '' = "use the
 * campaign default"). Previously inlined in `useContactDetail`.
 */
export const timezoneOptions: TimezoneOption[] = [
	{ value: '', label: 'Not set (use campaign default)' },
	{ value: 'America/New_York', label: 'Eastern Time (ET)' },
	{ value: 'America/Chicago', label: 'Central Time (CT)' },
	{ value: 'America/Denver', label: 'Mountain Time (MT)' },
	{ value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
	{ value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
	{ value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
	{ value: 'Europe/London', label: 'London (GMT/BST)' },
	{ value: 'Europe/Paris', label: 'Central European (CET)' },
	{ value: 'Europe/Berlin', label: 'Berlin (CET)' },
	{ value: 'Europe/Amsterdam', label: 'Amsterdam (CET)' },
	{ value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
	{ value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
	{ value: 'Asia/Singapore', label: 'Singapore (SGT)' },
	{ value: 'Asia/Dubai', label: 'Dubai (GST)' },
	{ value: 'Asia/Kolkata', label: 'India (IST)' },
	{ value: 'Australia/Sydney', label: 'Sydney (AEST)' },
	{ value: 'Australia/Melbourne', label: 'Melbourne (AEST)' },
	{ value: 'Pacific/Auckland', label: 'New Zealand (NZST)' },
];
