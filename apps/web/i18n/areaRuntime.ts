/**
 * The runtime half of the area catalogs (./catalogAreas.ts): merge a route
 * area's messages into vue-i18n BEFORE the route renders, so no screen ever
 * shows a key path where its copy belongs.
 *
 * - `prefetch(path)` starts downloading the area chunk as a navigation begins,
 *   alongside the route's component chunks;
 * - `ensure(path)` (from `router.beforeResolve`, after every middleware and
 *   redirect has settled) waits for it and merges it, and remembers the area;
 * - `switchLocale(locale)` (from `i18n:beforeLocaleSwitch`) merges every
 *   remembered area in the new language before the switch lands;
 * - `missing(locale, key)` is the net under all of it: a key the loaded
 *   catalogs lack, while chunks are still unloaded, renders as nothing (not as
 *   its path) while every remaining chunk loads; vue-i18n re-renders once they
 *   merge.
 *
 * Kept free of Nuxt imports so it runs under vitest as-is; the plugin
 * (app/plugins/i18n-areas.client.ts) wires it to the router and the i18n instance.
 */

/** A route area: every path equal to `path` or, unless `exact`, below it. */
export interface AreaRouteEntry {
	readonly path: string;
	readonly exact: boolean;
	readonly area: string;
}

export type AreaMessages = Record<string, unknown>;
export type AreaChunkLoader = () => Promise<{ default: AreaMessages }>;
/** Area → locale → the chunk's dynamic import. */
export type AreaChunks = Readonly<Record<string, Readonly<Record<string, AreaChunkLoader>>>>;

/** The areas whose chunks `path` needs. */
export function areasForPath(routes: readonly AreaRouteEntry[], path: string): string[] {
	const normalized = path.toLowerCase().replace(/\/+$/, '') || '/';
	return routes
		.filter(
			(route) =>
				normalized === route.path || (!route.exact && normalized.startsWith(`${route.path}/`))
		)
		.map((route) => route.area);
}

export interface AreaCatalogOptions {
	readonly routes: readonly AreaRouteEntry[];
	readonly chunks: AreaChunks;
	/** The catalog's top-level namespaces: a string under one of them is a key, not words. */
	readonly roots: readonly string[];
	readonly merge: (locale: string, messages: AreaMessages) => void;
	readonly locale: () => string;
	readonly onError?: (error: unknown) => void;
}

export interface AreaCatalogs {
	prefetch(path: string): void;
	ensure(path: string): Promise<void>;
	switchLocale(locale: string): Promise<void>;
	missing(locale: string, key: string): string | undefined;
}

export function createAreaCatalogs(options: AreaCatalogOptions): AreaCatalogs {
	const roots = new Set(options.roots);
	const id = (area: string, locale: string) => `${area}\u0000${locale}`;
	/** Areas a route has needed, reloaded on a locale switch. */
	const wanted = new Set<string>();
	const downloads = new Map<string, Promise<AreaMessages | undefined>>();
	const merged = new Set<string>();
	/** Locales the safety net is sweeping, or gave up on after a failed sweep. */
	const sweeping = new Set<string>();
	const gaveUp = new Set<string>();

	function download(area: string, locale: string): Promise<AreaMessages | undefined> {
		const key = id(area, locale);
		let pending = downloads.get(key);
		if (!pending) {
			const loader = options.chunks[area]?.[locale];
			pending = (
				loader ? loader().then((module) => module.default) : Promise.resolve(undefined)
			).catch((error: unknown) => {
				// A failed download (offline, a stale deploy) is retried on the next navigation.
				downloads.delete(key);
				options.onError?.(error);
				return undefined;
			});
			downloads.set(key, pending);
		}
		return pending;
	}

	async function load(areas: Iterable<string>, locale: string): Promise<void> {
		await Promise.all(
			[...areas].map(async (area) => {
				const key = id(area, locale);
				if (merged.has(key)) return;
				const messages = await download(area, locale);
				if (messages && !merged.has(key)) {
					options.merge(locale, messages);
					merged.add(key);
				}
			})
		);
	}

	const unloaded = (locale: string) =>
		Object.keys(options.chunks).filter((area) => !merged.has(id(area, locale)));

	return {
		prefetch(path) {
			const locale = options.locale();
			for (const area of areasForPath(options.routes, path)) void download(area, locale);
		},
		async ensure(path) {
			const areas = areasForPath(options.routes, path);
			for (const area of areas) wanted.add(area);
			await load(areas, options.locale());
		},
		async switchLocale(locale) {
			await load(wanted, locale);
		},
		missing(locale, key) {
			const dot = key.indexOf('.');
			if (dot <= 0 || !roots.has(key.slice(0, dot)) || gaveUp.has(locale)) return undefined;
			const remaining = unloaded(locale);
			if (remaining.length === 0) return undefined;
			if (!sweeping.has(locale)) {
				sweeping.add(locale);
				void load(remaining, locale).then(() => {
					sweeping.delete(locale);
					if (unloaded(locale).length > 0) gaveUp.add(locale);
				});
			}
			return '';
		},
	};
}
