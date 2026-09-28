/**
 * Date/time and number formats, named once and shared by every locale.
 *
 * These are vue-i18n's `datetimeFormats` / `numberFormats`, so a template can
 * say `$d(value, 'medium')` and `$n(value, 'compact')` and get the active
 * locale's rendering of a format this product defined — rather than a bare
 * `Intl` call with an options bag copy-pasted per call site, which is how the
 * app ended up with three spellings of "short date" and a hard-coded `'en-US'`
 * underneath all of them.
 *
 * SAME OPTIONS FOR EVERY LOCALE, on purpose. `Intl` is what differs per locale:
 * `{ month: 'short', day: 'numeric' }` is "Mar 3" in English and "3. März" in
 * German off the same table. A per-locale options table would be re-inventing
 * CLDR by hand, badly.
 *
 * Lives in its own module rather than inside `i18n.config.ts` because the test
 * i18n instance (`app/__tests__/i18n.ts`) has to install the same tables — a
 * suite that formatted against a different set of formats would be testing
 * something the browser never renders.
 */

import { APP_LOCALES, type AppLocale } from '@owlat/shared/appLocales';

/** Named date/time formats. Keys are the vocabulary the app formats in. */
const DATE_TIME_FORMATS = {
	/** Day and month, for a timestamp inside the current year. "Mar 3" */
	short: { month: 'short', day: 'numeric' },
	/** The default calendar date. "Mar 3, 2024" */
	medium: { month: 'short', day: 'numeric', year: 'numeric' },
	/** Spelled-out month, for headings and prose. "March 3, 2024" */
	long: { month: 'long', day: 'numeric', year: 'numeric' },
	/** With the weekday, for a single focal date. "Sunday, March 3, 2024" */
	full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
	/** Date and clock time together. "Mar 3, 2024, 09:30" */
	dateTime: {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	},
	/** Clock time alone. "09:30" */
	time: { hour: '2-digit', minute: '2-digit' },
} as const;

/** Named number formats. */
const NUMBER_FORMATS = {
	/** Grouped integer/decimal. "1,234" (en) / "1.234" (de) */
	decimal: {},
	/** Abbreviated for tight tiles. "1.2K" (en) / "1234" -> "1234" (de: "1200") */
	compact: { notation: 'compact', compactDisplay: 'short' },
	/**
	 * A RATIO (0–1) as a percentage. `Intl` owns the ×100 and the locale's
	 * spacing rule — German writes "12,3 %" with a no-break space, which every
	 * hand-rolled `${value}%` in this app got wrong.
	 */
	percent: { style: 'percent', maximumFractionDigits: 1 },
} as const;

/** `datetimeFormats` for `createI18n`, one entry per shipped locale (`APP_LOCALES`). */
export const datetimeFormats = Object.fromEntries(
	APP_LOCALES.map((locale) => [locale, DATE_TIME_FORMATS])
) as Record<AppLocale, typeof DATE_TIME_FORMATS>;

/** `numberFormats` for `createI18n`, one entry per shipped locale (`APP_LOCALES`). */
export const numberFormats = Object.fromEntries(
	APP_LOCALES.map((locale) => [locale, NUMBER_FORMATS])
) as Record<AppLocale, typeof NUMBER_FORMATS>;
