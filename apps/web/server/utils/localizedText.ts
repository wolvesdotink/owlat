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
 * So the boundary is here, and it is **English only**: the response is not a
 * rendered page and carries no `Accept-Language` negotiation. The words still
 * come from `i18n/locales/en.json`, so the refusal an API caller reads and the
 * dialog an operator reads cannot quote different stakes for one click.
 */
import en from '~~/i18n/locales/en.json';

/** A catalog key with its interpolations, or a sentence that is already words. */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

type Catalog = { [key: string]: string | Catalog };

/** The message at a dotted path, or `undefined` when the path is not one. */
function message(path: string): string | undefined {
	let node: string | Catalog | undefined = en as Catalog;
	for (const segment of path.split('.')) {
		if (typeof node !== 'object' || node === null) return undefined;
		node = node[segment];
	}
	return typeof node === 'string' ? node : undefined;
}

/**
 * Render `value` in English.
 *
 * A parameter is resolved too when it is itself a key: the vocabulary modules
 * name a transport through `transportIdLabel`, which returns a catalog key for
 * the kinds whose name is copy rather than a vendor's own spelling — so a
 * sentence about one of those would otherwise read "…still send through
 * shared.transportState.labels.mandrill".
 */
export function localizeEn(value: LocalizedText): string {
	if (typeof value === 'string') return message(value) ?? value;
	const template = message(value.key) ?? value.key;
	return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
		const param = value.params?.[name];
		if (param === undefined) return match;
		const rendered = String(param);
		return message(rendered) ?? rendered;
	});
}
