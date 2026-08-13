/**
 * THE REAL MESSAGE CATALOG, NOT A `t: (key) => key` STUB.
 *
 * The extracted surfaces render every visible string through vue-i18n, so a
 * stub that echoed key paths would audit markup no user ever sees — and would
 * hide exactly the failures these suites exist to catch (a control whose
 * accessible name is now a missing key, a label bound to a message that does
 * not exist). Mounting with `i18n/locales/en.json` keeps the audited page
 * character-for-character the one the browser paints.
 */
import { createI18n, useI18n } from 'vue-i18n';
import en from '~~/i18n/locales/en.json';

/** A fresh i18n instance per suite — locale state must not leak between mounts. */
export function createTestI18n() {
	return createI18n({
		legacy: false,
		locale: 'en',
		fallbackLocale: 'en',
		messages: { en },
	});
}

/**
 * `useI18n` is an auto-import in the app, so it has to be a global here; the
 * real one resolves against whichever instance `global.plugins` installed.
 */
export const i18nStubs = { useI18n };
