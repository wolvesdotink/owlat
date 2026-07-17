/**
 * Conformance pins for the built-in ("core") command-palette providers.
 *
 * The piece requires existing palette behavior (results, ordering) to stay
 * pinned by tests across the registry conversion. These assertions freeze the
 * composition of `buildCorePaletteProviders` so transposing a group `order`,
 * dropping a `cap`, renaming an id, changing a priority, or inverting a
 * idle-vs-query gate breaks a named test — the synthetic-provider registry suite
 * would not catch any of those.
 */
import { describe, it, expect } from 'vitest';
import type { PaletteGroup, PaletteItem } from '../commandPalette';
import {
	type CorePaletteProviderDeps,
	type SearchResult,
	type SearchResults,
	buildCorePaletteProviders,
} from '../commandPaletteCore';

function paletteItem(id: string): PaletteItem {
	return { id, label: id, icon: 'lucide:dot', run: () => {} };
}

function searchHit(id: string): SearchResult {
	return { id, type: 'contact', title: id, subtitle: '', url: `/x/${id}` };
}

const EMPTY_RESULTS: SearchResults = { contacts: [], emails: [], campaigns: [] };

/** Deps with sensible non-empty defaults; each test overrides what it needs. */
function makeDeps(overrides: Partial<CorePaletteProviderDeps> = {}): CorePaletteProviderDeps {
	return {
		recentSearches: () => ['acme', 'globex'],
		verbItems: () => [paletteItem('verb:new-contact')],
		contextItems: () => [paletteItem('context:inbox')],
		navItems: () => [paletteItem('nav:/dashboard/inbox')],
		searchResults: () => EMPTY_RESULTS,
		onRecentTerm: () => {},
		buildResultItems: (results) => results.map((r) => paletteItem(`search:${r.id}`)),
		...overrides,
	};
}

/** Build the provider with the given id and run its `build` for `query`. */
function build(id: string, query: string, overrides: Partial<CorePaletteProviderDeps> = {}) {
	const provider = buildCorePaletteProviders(makeDeps(overrides)).find((p) => p.id === id);
	if (!provider) throw new Error(`no core provider ${id}`);
	return provider.build({ query });
}

function groupByKey(groups: PaletteGroup[], key: string): PaletteGroup | undefined {
	return groups.find((g) => g.key === key);
}

describe('buildCorePaletteProviders — provider set', () => {
	it('is exactly the five core providers, in priority order, at fixed priorities', () => {
		const providers = buildCorePaletteProviders(makeDeps());
		expect(providers.map((p) => p.id)).toEqual([
			'core:recent',
			'core:verbs',
			'core:context',
			'core:search',
			'core:navigation',
		]);
		expect(providers.map((p) => p.priority)).toEqual([10, 20, 30, 40, 50]);
	});

	it('declares no flag or route gate on any core provider (core is always consulted)', () => {
		for (const provider of buildCorePaletteProviders(makeDeps())) {
			expect(provider.flag).toBeUndefined();
			expect(provider.matchRoute).toBeUndefined();
		}
	});
});

describe('core:recent', () => {
	it('shows recent terms only in the idle state, capped, at order -1', () => {
		const groups = build('core:recent', '');
		const recent = groupByKey(groups, 'recent');
		expect(recent?.order).toBe(-1);
		expect(recent?.cap).toBe(5);
		expect(recent?.heading).toBe('Recent searches');
		expect(recent?.items.map((i) => i.id)).toEqual(['recent:acme', 'recent:globex']);
		// Recent items keep the palette open (they refill the query).
		expect(recent?.items.every((i) => i.keepOpen === true)).toBe(true);
	});

	it('is silent once the query reaches the search threshold', () => {
		expect(build('core:recent', 'ac')).toEqual([]);
	});

	it('is silent when there are no recent terms', () => {
		expect(build('core:recent', '', { recentSearches: () => [] })).toEqual([]);
	});
});

describe('core:verbs and core:context', () => {
	it('always contribute their group, at fixed order, filtered by the query', () => {
		const verbs = groupByKey(build('core:verbs', ''), 'verbs');
		expect(verbs?.order).toBe(5);
		expect(verbs?.heading).toBe('Create');
		expect(verbs?.cap).toBeUndefined();

		const context = groupByKey(build('core:context', ''), 'context');
		expect(context?.order).toBe(6);
		expect(context?.heading).toBe('Context');

		// The query filters items (a non-matching query empties the group).
		const filtered = groupByKey(build('core:verbs', 'zzzz'), 'verbs');
		expect(filtered?.items).toEqual([]);
	});
});

describe('core:search', () => {
	it('is silent below the query threshold and until results resolve', () => {
		const results: SearchResults = { contacts: [searchHit('c1')], emails: [], campaigns: [] };
		expect(build('core:search', 'a', { searchResults: () => results })).toEqual([]);
		expect(build('core:search', 'acme', { searchResults: () => undefined })).toEqual([]);
	});

	it('emits contacts/campaigns/templates at orders 20/21/22, cap 5, from the result lists', () => {
		const results: SearchResults = {
			contacts: [searchHit('c1')],
			campaigns: [searchHit('m1')],
			emails: [searchHit('e1')],
		};
		const groups = build('core:search', 'acme', { searchResults: () => results });
		expect(groups.map((g) => [g.key, g.order, g.cap, g.items.map((i) => i.id)])).toEqual([
			['contacts', 20, 5, ['search:c1']],
			['campaigns', 21, 5, ['search:m1']],
			['templates', 22, 5, ['search:e1']],
		]);
	});
});

describe('core:navigation', () => {
	it('contributes the navigation group at order 40, cap 8', () => {
		const nav = groupByKey(build('core:navigation', ''), 'navigation');
		expect(nav?.order).toBe(40);
		expect(nav?.cap).toBe(8);
		expect(nav?.heading).toBe('Go to');
		expect(nav?.items.map((i) => i.id)).toEqual(['nav:/dashboard/inbox']);
	});
});
