/**
 * Pure factory for the app command palette's built-in ("core") providers.
 *
 * The core providers — recent searches, the two Mail-scope providers (grammar
 * completions + live deep-search hits), verbs, sidebar-context switch, settings
 * controls, object search, mail, and navigation — used to live as inline closures inside
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
 * injects. Kept free of Vue/Nuxt so the whole matrix is unit-testable — which is
 * also why every group heading here is an i18n KEY the palette translates.
 *
 * Each group also declares which prefix MODE it answers to (`>` commands, `@`
 * people, `#` labels); a group with no `mode` shows only in the unprefixed
 * palette. The shell does the filtering — see `groupsForMode` — so a provider
 * never re-implements the prefix grammar.
 */
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';
import type { CommandPaletteProvider } from './commandPaletteRegistry';
import { filterByKeywords } from './settingsRegistry';

/**
 * A palette row for one SETTINGS CONTROL rather than a destination. It carries
 * localized synonyms so "dark" finds Appearance and "out of office" finds the
 * vacation auto-reply; the words are search-only and never rendered.
 */
export interface SettingsPaletteItem extends PaletteItem {
	keywords: readonly string[];
}

/** A single object-search hit from the shared search index. */
export interface SearchResult {
	id: string;
	type: string;
	title: string;
	subtitle: string;
	url: string;
	/** Mail hits only: the mailbox the message lives in (may not be the active one). */
	mailboxId?: string;
}

/** The object-search result lists surfaced by the palette. */
export interface SearchResults {
	contacts: SearchResult[];
	emails: SearchResult[];
	campaigns: SearchResult[];
	/** Messages across every mailbox the caller can read. */
	mail: SearchResult[];
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
	/**
	 * Individual settings CONTROLS (dark mode, auto-advance, notify me about),
	 * each deep-linking to the section that holds it. Search-only: they stay out
	 * of the idle palette so ⌘K opens on destinations, not on twenty switches.
	 */
	settingsItems: () => SettingsPaletteItem[];
	/** Current object-search results, or undefined while none have resolved. */
	searchResults: () => SearchResults | undefined;
	/** Refill the palette query with a recent term (palette stays open). */
	onRecentTerm: (term: string) => void;
	/** Map one object-search list to palette items (adds save-recent + navigate). */
	buildResultItems: (results: SearchResult[]) => PaletteItem[];
	/**
	 * Map mail hits to palette items. Separate from `buildResultItems` because
	 * opening a message may first have to switch the active mailbox, and because
	 * an empty subject needs the component's translator.
	 */
	buildMailItems: (results: SearchResult[]) => PaletteItem[];
	/** The "search all mail for <term>" escape hatch under the mail hits. */
	buildSearchMailItem: (term: string) => PaletteItem;
	/**
	 * Whether the overlay is in MAIL scope — the deep-search corpus with the
	 * operator grammar, not the cross-object index. Only the two mail-scope
	 * providers below consult it; the rest keep contributing and are narrowed by
	 * `groupsForScope` in the shell, so one rule decides what Mail scope shows.
	 */
	isMailScope: () => boolean;
	/**
	 * Operator/contact/label completions for the token under the caret, already
	 * mapped to rows that rewrite the box (`~/utils/postboxSearchSuggest`).
	 */
	mailSuggestionItems: () => PaletteItem[];
	/** Live top hits from `mail.mailbox.search.search`, newest first. */
	mailHitItems: () => PaletteItem[];
}

/**
 * Build the ordered core provider set. Priorities fix the consult/dedup order
 * (10/12/13/20/30/35/40/45/50); each provider's group `order` still drives the final
 * render sort in `mergeGroups`. Pure.
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
						heading: 'shared.commandPaletteCore.groups.recent',
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
			// Mail scope: what the grammar offers for the token under the caret.
			// Ranked above the hits — a completion the user is mid-way through
			// typing beats a message that matched the half-typed operator.
			id: 'core:mail-suggest',
			priority: 12,
			build: (): PaletteGroup[] => {
				if (!deps.isMailScope()) return [];
				return [
					{
						key: 'mail-suggest',
						heading: 'shared.commandPaletteCore.groups.refine',
						order: 1,
						cap: 6,
						items: deps.mailSuggestionItems(),
					},
				];
			},
		},
		{
			// Mail scope: the top live hits from the deep search, so the overlay
			// answers before the user commits to the results page.
			id: 'core:mail-hits',
			priority: 13,
			build: ({ query }): PaletteGroup[] => {
				if (!deps.isMailScope() || query.trim().length < SEARCH_MIN_QUERY) return [];
				return [
					{
						key: 'mail-hits',
						heading: 'shared.commandPaletteCore.groups.mail',
						order: 2,
						cap: 5,
						items: deps.mailHitItems(),
					},
				];
			},
		},
		{
			// Verbs / utilities.
			id: 'core:verbs',
			priority: 20,
			build: ({ query }): PaletteGroup[] => [
				{
					key: 'verbs',
					heading: 'common.create',
					order: 5,
					mode: 'commands',
					items: filterItems(deps.verbItems(), query),
				},
			],
		},
		{
			// Sidebar-context switch (empty groups are dropped on merge).
			id: 'core:context',
			priority: 30,
			build: ({ query }): PaletteGroup[] => [
				{
					key: 'context',
					heading: 'shared.commandPaletteCore.groups.context',
					order: 6,
					mode: 'commands',
					items: filterItems(deps.contextItems(), query),
				},
			],
		},
		{
			// Settings controls — the switches themselves, matched on their synonyms
			// as well as their names. Only once something is typed: the idle palette
			// answers "where do I go", not "which switch exists".
			id: 'core:settings',
			priority: 35,
			build: ({ query }): PaletteGroup[] => {
				if (!query.trim()) return [];
				return [
					{
						key: 'settings',
						heading: 'shared.commandPaletteCore.groups.settings',
						order: 30,
						cap: 6,
						mode: 'commands',
						items: filterByKeywords(deps.settingsItems(), query),
					},
				];
			},
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
						heading: 'shared.commandPaletteCore.groups.contacts',
						order: 20,
						cap: 5,
						mode: 'people',
						items: deps.buildResultItems(results.contacts),
					},
					{
						key: 'campaigns',
						heading: 'shared.commandPaletteCore.groups.campaigns',
						order: 21,
						cap: 5,
						items: deps.buildResultItems(results.campaigns),
					},
					{
						key: 'templates',
						heading: 'shared.commandPaletteCore.groups.templates',
						order: 22,
						cap: 5,
						items: deps.buildResultItems(results.emails),
					},
				];
			},
		},
		{
			// Mail — messages across every readable mailbox, plus the "search all
			// mail" escape hatch that always closes the section.
			id: 'core:mail',
			priority: 45,
			build: ({ query }): PaletteGroup[] => {
				const term = query.trim();
				if (term.length < SEARCH_MIN_QUERY) return [];
				const results = deps.searchResults();
				const groups: PaletteGroup[] = [];
				if (results && results.mail.length > 0) {
					groups.push({
						key: 'mail',
						heading: 'shared.commandPaletteCore.groups.mail',
						order: 18,
						cap: 5,
						items: deps.buildMailItems(results.mail),
					});
				}
				// Offered even while the hits are still resolving (and when there are
				// none): the full mail search understands operators this never will.
				groups.push({
					key: 'mail-search',
					heading: 'shared.commandPaletteCore.groups.goTo',
					order: 19,
					items: [deps.buildSearchMailItem(term)],
				});
				return groups;
			},
		},
		{
			// Navigation — every sidebar destination.
			id: 'core:navigation',
			priority: 50,
			build: ({ query }): PaletteGroup[] => [
				{
					key: 'navigation',
					heading: 'shared.commandPaletteCore.groups.navigation',
					order: 40,
					cap: 8,
					mode: 'commands',
					items: filterItems(deps.navItems(), query),
				},
			],
		},
	];
}
