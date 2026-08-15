/**
 * Locale-aware reads of the docs content tree.
 *
 * The markdown lives in one collection per locale (`content_en`, `content_de`
 * — see `content.config.ts`) and every collection publishes the SAME
 * locale-free paths: `/guide/quick-start`, never `/de/guide/quick-start`. The
 * `/de` segment is a routing concern owned by `@nuxtjs/i18n`, so anything that
 * talks to the content database has to strip it first ({@link contentPath})
 * and pick the collection separately ({@link docsCollection}).
 *
 * THE GERMAN MIRROR IS INCOMPLETE BY DESIGN — it is filled in page by page.
 * Every read of a non-default collection therefore falls back to `content_en`,
 * so a German URL whose page has not been translated yet renders the English
 * page rather than a 404. That fallback is the reason these helpers exist
 * instead of a bare `queryCollection(collection)` at each call site.
 */

/** The page collections defined in `content.config.ts`, one per locale. */
export type DocsCollection = 'content_en' | 'content_de';

/** The locale whose pages are served unprefixed (`i18n.defaultLocale`). */
export const DEFAULT_DOCS_LOCALE = 'en';

/** The fallback collection: the source every other locale is translated from. */
export const DEFAULT_DOCS_COLLECTION: DocsCollection = 'content_en';

const COLLECTION_BY_LOCALE: Record<string, DocsCollection> = {
	en: 'content_en',
	de: 'content_de',
};

/** The content collection backing a locale — English for anything unknown. */
export function docsCollection(locale: string): DocsCollection {
	return COLLECTION_BY_LOCALE[locale] ?? DEFAULT_DOCS_COLLECTION;
}

/**
 * A router path with its locale prefix removed, i.e. the path the content
 * database stores. `/de/guide/quick-start` → `/guide/quick-start`; `/de` → `/`.
 */
export function contentPath(routePath: string, locale: string): string {
	if (locale === DEFAULT_DOCS_LOCALE) return routePath;
	const prefix = `/${locale}`;
	if (routePath === prefix) return '/';
	return routePath.startsWith(`${prefix}/`) ? routePath.slice(prefix.length) : routePath;
}

/** One page, falling back to its English source when untranslated. */
export async function queryDocsPage(collection: DocsCollection, path: string) {
	const page = await queryCollection(collection).path(path).first();
	if (page || collection === DEFAULT_DOCS_COLLECTION) return page;
	return await queryCollection(DEFAULT_DOCS_COLLECTION).path(path).first();
}

/**
 * Title-matching pages for the search palette.
 *
 * The localized hits come first; English pages that have no translation yet are
 * appended so the index never loses a page just because it is untranslated.
 */
export async function queryDocsSearch(collection: DocsCollection, term: string) {
	// An empty box is not a query for "every page": `LIKE '%%'` matches the whole
	// tree, which the palette then throws away because it only renders results
	// once something is typed.
	if (term.trim() === '') return [];

	const select = (name: DocsCollection) =>
		queryCollection(name)
			.where('title', 'LIKE', `%${term}%`)
			.select('path', 'title', 'description')
			.all();

	const localized = await select(collection);
	if (collection === DEFAULT_DOCS_COLLECTION) return localized;

	const translated = new Set(localized.map((page) => page.path));
	const english = await select(DEFAULT_DOCS_COLLECTION);
	return [...localized, ...english.filter((page) => !translated.has(page.path))];
}

/**
 * The previous and next page around `path`, in reading order.
 *
 * Ordering ALWAYS comes from the English collection: it is the only complete
 * one, and deriving the sequence from a half-filled German mirror would let
 * prev/next skip every untranslated page — a reader would walk a different
 * (and shorter) book depending on the locale. Only the titles are localized,
 * which is exactly the part a translation supplies.
 */
export async function queryDocsSurroundings(collection: DocsCollection, path: string) {
	const surroundings = await queryCollectionItemSurroundings(DEFAULT_DOCS_COLLECTION, path, {
		before: 1,
		after: 1,
	});

	if (collection === DEFAULT_DOCS_COLLECTION) return surroundings;

	const paths = (surroundings ?? []).filter(Boolean).map((item) => item.path as string);
	if (paths.length === 0) return surroundings;

	const localized = await queryCollection(collection)
		.where('path', 'IN', paths)
		.select('path', 'title')
		.all();
	const titles = new Map(localized.map((page) => [page.path, page.title]));

	return (surroundings ?? []).map((item) =>
		item && titles.has(item.path as string)
			? { ...item, title: titles.get(item.path as string)! }
			: item
	);
}
