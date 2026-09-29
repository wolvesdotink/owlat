/**
 * The `i18n.locales` entries `nuxt.config.ts` registers, built from the shared
 * list (`@owlat/shared/appLocales`) so the web app, the Convex validator and
 * system mail cannot disagree about which languages ship.
 *
 * Its own module so the language picker's test reads the same list the i18n
 * module is configured with, instead of restating it.
 */
import { APP_LOCALES, APP_LOCALE_BCP47, type AppLocale } from '@owlat/shared/appLocales';

// Each shipped language's name in its own language, for the picker. Keyed by
// `AppLocale`, so a locale added to the shared list fails to compile here until
// it has a name (and `i18n/locales/<code>.json` a catalog).
const LOCALE_DISPLAY_NAMES: Record<AppLocale, string> = { en: 'English', de: 'Deutsch' };

export const I18N_LOCALES = APP_LOCALES.map((code) => ({
	code,
	language: APP_LOCALE_BCP47[code],
	name: LOCALE_DISPLAY_NAMES[code],
	file: `${code}.json`,
}));
