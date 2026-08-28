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
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Group headings are catalog keys — the factory is module scope and never calls
 * `useI18n`, so the palette component translates them. These assertions render
 * through the real catalog and stay on the words a user reads.
 */
const { t } = createTestI18n().global;

function paletteItem(id: string): PaletteItem {
	return { id, label: id, icon: 'lucide:dot', run: () => {} };
}

function searchHit(id: string): SearchResult {
	return { id, type: 'contact', title: id, subtitle: '', url: `/x/${id}` };
}

const EMPTY_RESULTS: SearchResults = { contacts: [], emails: [], campaigns: [], mail: [] };

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
		buildMailItems: (results) => results.map((r) => paletteItem(`mail:${r.id}`)),
		buildSearchMailItem: (term) => paletteItem(`mail:search-for:${term}`),
		...overrides,
	};
}

/** Build the provider with the given id and run its `build` for `query`. */
function build(id: string, query: string, overrides: Partial<CorePaletteProviderDeps> = {}) {
	const provider = buildCorePaletteProviders(makeDeps(overrides)).find((p) => p.id === id);
	if (!provider) throw new Error(`no core provider ${id}`);
	return provider.build({ query, mode: 'all' });
}

function groupByKey(groups: PaletteGroup[], key: string): PaletteGroup | undefined {
	return groups.find((g) => g.key === key);
}

describe('buildCorePaletteProviders — provider set', () => {
	it('is exactly the six core providers, in priority order, at fixed priorities', () => {
		const providers = buildCorePaletteProviders(makeDeps());
		expect(providers.map((p) => p.id)).toEqual([
			'core:recent',
			'core:verbs',
			'core:context',
			'core:search',
			'core:mail',
			'core:navigation',
		]);
		expect(providers.map((p) => p.priority)).toEqual([10, 20, 30, 40, 45, 50]);
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
		expect(t(recent?.heading ?? '')).toBe('Recent searches');
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
		expect(t(verbs?.heading ?? '')).toBe('Create');
		expect(verbs?.cap).toBeUndefined();

		const context = groupByKey(build('core:context', ''), 'context');
		expect(context?.order).toBe(6);
		expect(t(context?.heading ?? '')).toBe('Context');

		// The query filters items (a non-matching query empties the group).
		const filtered = groupByKey(build('core:verbs', 'zzzz'), 'verbs');
		expect(filtered?.items).toEqual([]);
	});
});

describe('core:search', () => {
	it('is silent below the query threshold and until results resolve', () => {
		const results: SearchResults = {
			contacts: [searchHit('c1')],
			emails: [],
			campaigns: [],
			mail: [],
		};
		expect(build('core:search', 'a', { searchResults: () => results })).toEqual([]);
		expect(build('core:search', 'acme', { searchResults: () => undefined })).toEqual([]);
	});

	it('emits contacts/campaigns/templates at orders 20/21/22, cap 5, from the result lists', () => {
		const results: SearchResults = {
			contacts: [searchHit('c1')],
			campaigns: [searchHit('m1')],
			emails: [searchHit('e1')],
			mail: [],
		};
		const groups = build('core:search', 'acme', { searchResults: () => results });
		expect(groups.map((g) => [g.key, g.order, g.cap, g.items.map((i) => i.id)])).toEqual([
			['contacts', 20, 5, ['search:c1']],
			['campaigns', 21, 5, ['search:m1']],
			['templates', 22, 5, ['search:e1']],
		]);
	});
});

describe('core:mail', () => {
	const withMail = (mail: SearchResult[]) => ({
		searchResults: () => ({ ...EMPTY_RESULTS, mail }),
	});

	it('is silent below the query threshold', () => {
		expect(build('core:mail', 'a', withMail([searchHit('m1')]))).toEqual([]);
	});

	it('emits the mail hits at order 18, cap 5, above the search-mail row at 19', () => {
		const groups = build('core:mail', 'invoice', withMail([searchHit('m1')]));
		expect(groups.map((g) => [g.key, g.order, g.cap, g.items.map((i) => i.id)])).toEqual([
			['mail', 18, 5, ['mail:m1']],
			['mail-search', 19, undefined, ['mail:search-for:invoice']],
		]);
		expect(t(groups[0]?.heading ?? '')).toBe('Mail');
	});

	it('still offers the search-mail row while hits are missing or unresolved', () => {
		expect(build('core:mail', 'invoice', withMail([])).map((g) => g.key)).toEqual(['mail-search']);
		expect(
			build('core:mail', 'invoice', { searchResults: () => undefined }).map((g) => g.key)
		).toEqual(['mail-search']);
	});
});

describe('group modes', () => {
	it('tags the command-ish groups so a `>` search finds them', () => {
		const modeOf = (id: string, key: string) => groupByKey(build(id, ''), key)?.mode;
		expect(modeOf('core:verbs', 'verbs')).toBe('commands');
		expect(modeOf('core:context', 'context')).toBe('commands');
		expect(modeOf('core:navigation', 'navigation')).toBe('commands');
	});

	it('tags contacts as people and leaves the rest out of narrowed modes', () => {
		const search = build('core:search', 'acme', {
			searchResults: () => ({ ...EMPTY_RESULTS, contacts: [searchHit('c1')] }),
		});
		expect(groupByKey(search, 'contacts')?.mode).toBe('people');
		expect(groupByKey(search, 'campaigns')?.mode).toBeUndefined();
		expect(groupByKey(build('core:recent', ''), 'recent')?.mode).toBeUndefined();
	});
});

describe('core:navigation', () => {
	it('contributes the navigation group at order 40, cap 8', () => {
		const nav = groupByKey(build('core:navigation', ''), 'navigation');
		expect(nav?.order).toBe(40);
		expect(nav?.cap).toBe(8);
		expect(t(nav?.heading ?? '')).toBe('Go to');
		expect(nav?.items.map((i) => i.id)).toEqual(['nav:/dashboard/inbox']);
	});
});
