/**
 * Pure factory for the app command palette's built-in ("core") providers.
 *
 * The five core providers — recent searches, verbs, sidebar-context switch,
 * object search, and navigation — used to live as inline closures inside
 * `AppCommandPalette.vue`, so their ids, priorities, group keys, `order`/`cap`
 * values, and idle-vs-query gating conditions were untestable without mounting
 * the component. This factory extracts that composition, taking the reactive
 * reads as injected getters (the PP-15 `dashboardNavigation.ts` pattern) so the
 * component supplies its state and the built-in behavior the palette must
 * preserve is pinned by `__tests__/commandPaletteCore.test.ts`.
 *
 * The factory owns everything structural (which provider, at which priority,
 * contributing which group key at which order/cap, gated on which query
 * condition); the component owns only the data and the item `run` closures it
 * injects. Kept free of Vue/Nuxt so the whole matrix is unit-testable.
 */
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';
import type { CommandPaletteProvider } from './commandPaletteRegistry';

/** A single object-search hit from the shared search index. */
export interface SearchResult {
	id: string;
	type: string;
	title: string;
	subtitle: string;
	url: string;
}

/** The three object-search result lists surfaced by the palette. */
export interface SearchResults {
	contacts: SearchResult[];
	emails: SearchResult[];
	campaigns: SearchResult[];
}

/** Max recent-search terms kept and shown in the idle palette. */
export const MAX_RECENT_SEARCHES = 5;

/** Minimum query length before object search runs and its groups appear. */
export const SEARCH_MIN_QUERY = 2;

/**
 * Reactive inputs the core providers read while building. Passed as getters so
 * each provider's `build` re-reads the live value inside the assembling computed
 * (matching how the inline closures tracked their refs). The component keeps the
 * item `run` closures (navigation, save-recent) it injects here.
 */
export interface CorePaletteProviderDeps {
	/** Recent object-search terms, newest first. */
	recentSearches: () => readonly string[];
	/** Verb/utility items (New campaign, Compose, …). */
	verbItems: () => PaletteItem[];
	/** Sidebar-context switch item(s), empty when there is nothing to switch to. */
	contextItems: () => PaletteItem[];
	/** Navigation items — every sidebar destination. */
	navItems: () => PaletteItem[];
	/** Current object-search results, or undefined while none have resolved. */
	searchResults: () => SearchResults | undefined;
	/** Refill the palette query with a recent term (palette stays open). */
	onRecentTerm: (term: string) => void;
	/** Map one object-search list to palette items (adds save-recent + navigate). */
	buildResultItems: (results: SearchResult[]) => PaletteItem[];
}

/**
 * Build the ordered core provider set. Priorities fix the consult/dedup order
 * (10/20/30/40/50); each provider's group `order` still drives the final render
 * sort in `mergeGroups`. Pure.
 */
export function buildCorePaletteProviders(deps: CorePaletteProviderDeps): CommandPaletteProvider[] {
	return [
		{
			// Recent searches — only in the idle state, above everything.
			id: 'core:recent',
			priority: 10,
			build: ({ query }): PaletteGroup[] => {
				const recent = deps.recentSearches();
				if (query.trim().length >= SEARCH_MIN_QUERY || recent.length === 0) return [];
				return [
					{
						key: 'recent',
						heading: 'Recent searches',
						order: -1,
						cap: MAX_RECENT_SEARCHES,
						items: recent.map((term) => ({
							id: `recent:${term}`,
							label: term,
							icon: 'lucide:clock',
							keepOpen: true,
							run: () => deps.onRecentTerm(term),
						})),
					},
				];
			},
		},
		{
			// Verbs / utilities.
			id: 'core:verbs',
			priority: 20,
			build: ({ query }): PaletteGroup[] => [
				{ key: 'verbs', heading: 'Create', order: 5, items: filterItems(deps.verbItems(), query) },
			],
		},
		{
			// Sidebar-context switch (empty groups are dropped on merge).
			id: 'core:context',
			priority: 30,
			build: ({ query }): PaletteGroup[] => [
				{
					key: 'context',
					heading: 'Context',
					order: 6,
					items: filterItems(deps.contextItems(), query),
				},
			],
		},
		{
			// Object search — only once the query is meaningful and results arrived.
			id: 'core:search',
			priority: 40,
			build: ({ query }): PaletteGroup[] => {
				const results = deps.searchResults();
				if (query.trim().length < SEARCH_MIN_QUERY || !results) return [];
				return [
					{
						key: 'contacts',
						heading: 'Contacts',
						order: 20,
						cap: 5,
						items: deps.buildResultItems(results.contacts),
					},
					{
						key: 'campaigns',
						heading: 'Campaigns',
						order: 21,
						cap: 5,
						items: deps.buildResultItems(results.campaigns),
					},
					{
						key: 'templates',
						heading: 'Templates',
						order: 22,
						cap: 5,
						items: deps.buildResultItems(results.emails),
					},
				];
			},
		},
		{
			// Navigation — every sidebar destination.
			id: 'core:navigation',
			priority: 50,
			build: ({ query }): PaletteGroup[] => [
				{
					key: 'navigation',
					heading: 'Go to',
					order: 40,
					cap: 8,
					items: filterItems(deps.navItems(), query),
				},
			],
		},
	];
}
