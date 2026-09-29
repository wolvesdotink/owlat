/**
 * Complete translation catalogs, generated at build time.
 *
 * With `fallbackLocale: 'en'`, @nuxtjs/i18n loads a German visitor's catalogs
 * as a chain: all of `en` first, then `de`, one after the other, and vue-i18n
 * then deep-merges ~11k keys. Every key in `de.json` already has a translation
 * (the catalog tests enforce it), so all that work buys is a safety net.
 *
 * A production build therefore registers, for every locale except the source
 * one, a generated catalog with each key the translation lacks filled in from
 * `en`, and `i18n.config.ts` turns the runtime fallback off. A German visitor
 * downloads one catalog and a key a translation has not caught up with still
 * reads as English rather than as its key path. English never lands in
 * `de.json` itself: the fill happens in the build output only.
 *
 * The dev server keeps the plain files and the runtime fallback, so editing a
 * catalog hot-reloads and a missing key still warns in the console.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { I18N_LOCALES } from './localeOptions';

export type MessageCatalog = { [key: string]: string | MessageCatalog };

const SOURCE_LOCALE = 'en';
const LOCALES_DIR = fileURLToPath(new URL('./locales/', import.meta.url));
// Under node_modules so it is ignored everywhere a build artefact must be, and
// outside `.nuxt/`, which `nuxt build` clears after the modules have run.
const OUTPUT_DIR = fileURLToPath(new URL('../node_modules/.cache/owlat-i18n/', import.meta.url));

/** `nuxt dev` sets NODE_ENV before it loads the config; build, generate and prepare do not. */
export const USES_COMPLETE_CATALOGS = process.env['NODE_ENV'] !== 'development';

function isCatalog(value: unknown): value is MessageCatalog {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `translation` with every message it lacks taken from `source`. Its own
 * messages always win, including ones `source` does not have.
 */
export function completeCatalog(
	translation: MessageCatalog,
	source: MessageCatalog
): MessageCatalog {
	const complete: MessageCatalog = {};
	for (const [key, fallback] of Object.entries(source)) {
		const own = Object.hasOwn(translation, key) ? translation[key] : undefined;
		complete[key] =
			own === undefined
				? fallback
				: isCatalog(own) && isCatalog(fallback)
					? completeCatalog(own, fallback)
					: own;
	}
	for (const [key, own] of Object.entries(translation)) {
		if (!Object.hasOwn(complete, key)) complete[key] = own;
	}
	return complete;
}

const readCatalog = (path: string): MessageCatalog => JSON.parse(readFileSync(path, 'utf-8'));
const generatedPath = (file: string) => `${OUTPUT_DIR}${file}`;

/** The `i18n.locales` entries to register: the plain files in dev, the generated ones otherwise. */
export function i18nBuildLocales() {
	if (!USES_COMPLETE_CATALOGS) return I18N_LOCALES;
	return I18N_LOCALES.map((locale) =>
		locale.code === SOURCE_LOCALE ? locale : { ...locale, file: generatedPath(locale.file) }
	);
}

/**
 * Write the generated catalogs `i18nBuildLocales` points at. Runs on
 * `modules:before`, ahead of @nuxtjs/i18n reading (and hashing) its files.
 */
export function writeCompleteCatalogs(): void {
	if (!USES_COMPLETE_CATALOGS) return;
	const sourceFile = I18N_LOCALES.find((locale) => locale.code === SOURCE_LOCALE)!.file;
	const source = readCatalog(`${LOCALES_DIR}${sourceFile}`);
	mkdirSync(OUTPUT_DIR, { recursive: true });
	for (const locale of I18N_LOCALES) {
		if (locale.code === SOURCE_LOCALE) continue;
		const complete = completeCatalog(readCatalog(`${LOCALES_DIR}${locale.file}`), source);
		writeFileSync(generatedPath(locale.file), `${JSON.stringify(complete)}\n`);
	}
}
