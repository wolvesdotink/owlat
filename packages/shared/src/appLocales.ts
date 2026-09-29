/**
 * The interface languages this product ships — the one list.
 *
 * The web app's i18n config (`apps/web/nuxt.config.ts` → `i18n.locales`,
 * `apps/web/i18n/formats.ts`), the Convex validator on `userProfiles.locale`
 * and the system-email copy tables all derive from it, so a new language is
 * added here and every table keyed by `AppLocale` fails to compile until its
 * copy exists.
 *
 * Import-free on purpose: `nuxt.config.ts` loads it at build time.
 */
export const APP_LOCALES = ['en', 'de'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

const APP_LOCALE_SET: ReadonlySet<string> = new Set(APP_LOCALES);

/** Whether a stored or requested code is one this product ships. */
export function isAppLocale(value: unknown): value is AppLocale {
	return typeof value === 'string' && APP_LOCALE_SET.has(value);
}

/**
 * The BCP-47 tag `Intl` formats each interface language with. Naming the
 * region keeps a system email's dates consistent with what the app renders for
 * the same person.
 */
export const APP_LOCALE_BCP47: Record<AppLocale, string> = {
	en: 'en-US',
	de: 'de-DE',
};
