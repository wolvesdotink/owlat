/**
 * THE SERVER'S RENDER BOUNDARY FOR CATALOG COPY.
 *
 * The sentence tables under `app/utils` are pure modules: they hand back a
 * catalog key plus the values it interpolates, and whoever renders them turns
 * that into words. In the browser that renderer is vue-i18n. These Nitro routes
 * have no vue-i18n and no visitor to have a locale, but they do return prose —
 * a refusal a script, a log line or `curl` reads — and a route that dropped a
 * `{ key, params }` object into a template literal shipped `[object Object]` to
 * exactly those readers.
 *
 * So the boundary is here. The default is still English — an API refusal or a
 * log line has no visitor to have a locale, and it must read the same as the
 * dialog an operator sees. But the boundary now TAKES a locale, because one
 * class of caller does know who is reading: anything composed FOR a person we
 * have an account for, whose chosen language is on their profile
 * (`userProfiles.locale`). Those pass it; everything else keeps English.
 */
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';

/** A catalog key with its interpolations, or a sentence that is already words. */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

type Catalog = { [key: string]: string | Catalog };

/** The interface languages this app ships. Mirrors `nuxt.config` → `i18n.locales`. */
export type AppLocale = 'en' | 'de';

const CATALOGS: Record<AppLocale, Catalog> = { en: en as Catalog, de: de as Catalog };

/**
 * The message at a dotted path in `locale`, falling back to English — the same
 * `fallbackLocale: 'en'` the browser runs with, so a key a translation has not
 * caught up with reads as English rather than as a raw key path.
 */
function message(path: string, locale: AppLocale): string | undefined {
	const lookup = (catalog: Catalog): string | undefined => {
		let node: string | Catalog | undefined = catalog;
		for (const segment of path.split('.')) {
			if (typeof node !== 'object' || node === null) return undefined;
			node = node[segment];
		}
		return typeof node === 'string' ? node : undefined;
	};
	return lookup(CATALOGS[locale]) ?? (locale === 'en' ? undefined : lookup(CATALOGS.en));
}

/**
 * Render `value` in `locale`.
 *
 * A parameter is resolved too when it is itself a key: the vocabulary modules
 * name a transport through `transportIdLabel`, which returns a catalog key for
 * the kinds whose name is copy rather than a vendor's own spelling — so a
 * sentence about one of those would otherwise read "…still send through
 * shared.transportState.labels.mandrill".
 */
export function localize(value: LocalizedText, locale: AppLocale = 'en'): string {
	if (typeof value === 'string') return message(value, locale) ?? value;
	const template = message(value.key, locale) ?? value.key;
	return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
		const param = value.params?.[name];
		if (param === undefined) return match;
		const rendered = String(param);
		return message(rendered, locale) ?? rendered;
	});
}

/**
 * Render `value` in English. The name is the contract: every existing caller is
 * a response with no reader to have a locale (an API refusal, a log line, a
 * `curl`), and this states that rather than leaving it to a default someone
 * later "fixes".
 */
export function localizeEn(value: LocalizedText): string {
	return localize(value, 'en');
}
