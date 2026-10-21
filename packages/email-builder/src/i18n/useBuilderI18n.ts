import { computed, getCurrentInstance, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { appLocaleOf, type AppLocale } from '@owlat/shared/appLocales';
import de from './locales/de.json';
import en from './locales/en.json';

/**
 * The builder's translator for its OWN copy (`builder.*` keys).
 *
 * The catalogs ship with the package (`./locales/{en,de}.json`), so every
 * surface the host mounts — the whole editor, or just the previewer — reads
 * the same messages without the host registering anything. Only the LANGUAGE
 * comes from the host: the active locale of the app's vue-i18n instance, read
 * on every call so a locale switch re-renders the builder like the rest of the
 * page. Without a vue-i18n instance (a standalone mount, a unit test) the
 * builder renders English, the copy it hard-coded before extraction.
 *
 * Two kinds of message:
 *
 *  - `t(key, params)` — a keyed `builder.*` message. `{name}` placeholders are
 *    interpolated; a message written as `one | other` picks its form from the
 *    `count` param.
 *  - `label(source)` — registry metadata (block labels, property-panel schema
 *    labels and options, shortcut descriptions, slash commands). That copy is
 *    declared in English on frozen registry entries, and plugin blocks declare
 *    theirs the same way, so it is translated where it is DISPLAYED, looked up
 *    by its English source under `builder.meta`. Copy the catalog does not
 *    know (a plugin's own label) is shown as written.
 */

type MessageTree = { [key: string]: string | MessageTree };
type MessageParams = Record<string, string | number>;

const CATALOGS: Record<AppLocale, MessageTree> = { en, de };

function lookup(catalog: MessageTree, key: string): string | undefined {
	let node: string | MessageTree | undefined = catalog;
	for (const segment of key.split('.')) {
		if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment)) {
			return undefined;
		}
		node = node[segment];
	}
	return typeof node === 'string' ? node : undefined;
}

/** `one | other` (or `zero | one | other`), chosen by `count`. */
function pluralForm(message: string, count: number): string {
	const forms = message.split('|').map((form) => form.trim());
	if (forms.length === 2) return count === 1 ? forms[0]! : forms[1]!;
	if (forms.length === 3) return forms[Math.min(Math.max(count, 0), 2)]!;
	return message;
}

function interpolate(message: string, params?: MessageParams): string {
	if (!params) return message;
	const count = params['count'];
	const chosen = typeof count === 'number' ? pluralForm(message, count) : message;
	return chosen.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : match
	);
}

/** Translate a `builder.*` key in `locale`, falling back to English, then to the key. */
export function translate(locale: AppLocale, key: string, params?: MessageParams): string {
	const message = lookup(CATALOGS[locale], key) ?? lookup(CATALOGS.en, key) ?? key;
	return interpolate(message, params);
}

/**
 * The `builder.meta` key a piece of English registry copy is filed under:
 * its words camel-cased (`"Font Size"` → `builder.meta.fontSize`).
 */
export function metaKey(source: string): string {
	const words = source.match(/[A-Za-z0-9]+/g) ?? [];
	const slug = words
		.map((word, index) =>
			index === 0
				? word.charAt(0).toLowerCase() + word.slice(1)
				: word.charAt(0).toUpperCase() + word.slice(1)
		)
		.join('');
	return `builder.meta.${slug}`;
}

/**
 * Whether the catalog carries a translation of this English registry copy.
 * The English entry must read the same (ignoring case), so two different
 * phrases that happen to share a slug never borrow each other's translation.
 */
export function hasMetaLabel(source: string): boolean {
	const english = lookup(CATALOGS.en, metaKey(source));
	return english !== undefined && english.toLowerCase() === source.trim().toLowerCase();
}

/** Translate English registry copy; unknown copy (a plugin's) is returned as written. */
export function translateLabel(locale: AppLocale, source: string): string {
	if (locale === 'en' || !hasMetaLabel(source)) return source;
	return lookup(CATALOGS[locale], metaKey(source)) ?? source;
}

export interface BuilderI18n {
	/** The interface language the builder renders in. */
	locale: ComputedRef<AppLocale>;
	/** Translate a `builder.*` key. */
	t: (key: string, params?: MessageParams) => string;
	/** Translate English registry copy (see the module comment). */
	label: (source: string) => string;
}

interface HostLocale {
	locale: { value: unknown };
}

/**
 * The host app's vue-i18n composer, or `null` when there is none. `useI18n()`
 * may only run synchronously in a setup context and throws without an
 * installed instance, hence the guard and the catch.
 */
function tryUseHostLocale(): HostLocale | null {
	if (!getCurrentInstance()) return null;
	try {
		return useI18n() as unknown as HostLocale;
	} catch {
		return null;
	}
}

export function useBuilderI18n(): BuilderI18n {
	const host = tryUseHostLocale();
	const locale = computed<AppLocale>(() => {
		const active = host?.locale.value;
		return typeof active === 'string' ? appLocaleOf(active) : 'en';
	});
	return {
		locale,
		t: (key, params) => translate(locale.value, key, params),
		label: (source) => translateLabel(locale.value, source),
	};
}
