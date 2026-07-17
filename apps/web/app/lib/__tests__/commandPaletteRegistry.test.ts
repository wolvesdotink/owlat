/**
 * Behavior-preservation, gating, and trust-precedence coverage for the
 * command-palette provider registry. Every rule the palette relies on is pinned
 * here so a refactor that changes ordering, dedup, gating, or the core-vs-
 * external trust boundary fails loudly:
 *   - `activeProviders`: id dedup (first claimant wins, even when gated off),
 *     flag gating, route gating, `(priority, id)` order within a tier, and the
 *     structural guarantee that every core provider precedes every external one;
 *   - `collectProviderGroups`: group-key and item-id dedup resolving to the
 *     earlier provider, empty-group passthrough, and provider-order output;
 *   - `resolvePaletteGroups`: the two composed, proving an external provider can
 *     add work but can never shadow, reorder, or hijack a core provider — even
 *     when it declares a lower `priority`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { PaletteGroup, PaletteItem } from '../commandPalette';
import {
	type CommandPaletteProvider,
	type PaletteGateContext,
	activeProviders,
	collectProviderGroups,
	resolvePaletteGroups,
	routePrefixMatcher,
} from '../commandPaletteRegistry';

function item(id: string, label = id): PaletteItem {
	return { id, label, icon: 'lucide:dot', run: () => {} };
}

function group(key: string, order: number, items: PaletteItem[]): PaletteGroup {
	return { key, heading: key, order, items };
}

function provider(
	partial: Partial<CommandPaletteProvider> & Pick<CommandPaletteProvider, 'id'>
): CommandPaletteProvider {
	return { priority: 0, build: () => [], ...partial };
}

/** Gate that enables the given flags and, optionally, pins the active path. */
function gate(enabled: FeatureFlagKey[] = [], path = '/dashboard'): PaletteGateContext {
	const set = new Set<FeatureFlagKey>(enabled);
	return { path, isFlagEnabled: (flag) => set.has(flag) };
}

describe('activeProviders', () => {
	it('orders each tier by priority then id, independent of registration order', () => {
		const result = activeProviders(
			[
				provider({ id: 'b', priority: 10 }),
				provider({ id: 'a', priority: 10 }),
				provider({ id: 'c', priority: 5 }),
			],
			[],
			gate()
		);
		expect(result.map((p) => p.id)).toEqual(['c', 'a', 'b']);
	});

	it('consults every core provider before any external provider', () => {
		// The external provider declares the lowest priority; it still lands last.
		const result = activeProviders(
			[provider({ id: 'core', priority: 100 })],
			[provider({ id: 'ext', priority: -100 })],
			gate()
		);
		expect(result.map((p) => p.id)).toEqual(['core', 'ext']);
	});

	it('claims an id on first registration so a duplicate can never shadow it', () => {
		const core = provider({ id: 'shared', build: () => [group('core', 0, [item('x')])] });
		const shadow = provider({ id: 'shared', build: () => [group('evil', 0, [item('x')])] });
		expect(activeProviders([core], [shadow], gate())).toEqual([core]);
	});

	it('lets a core id block a same-id external provider even when core is gated off', () => {
		// A gated-off core provider must still block an external contribution, so a
		// plugin cannot resurrect a disabled core id under its own control.
		const gatedCore = provider({ id: 'shared', flag: 'campaigns' });
		const external = provider({ id: 'shared' });
		expect(activeProviders([gatedCore], [external], gate([]))).toEqual([]);
	});

	it('drops a provider whose feature flag is disabled and keeps it when enabled', () => {
		const gated = provider({ id: 'g', flag: 'campaigns' });
		expect(activeProviders([gated], [], gate([])).map((p) => p.id)).toEqual([]);
		expect(activeProviders([gated], [], gate(['campaigns'])).map((p) => p.id)).toEqual(['g']);
	});

	it('drops a route-gated provider off its route and keeps a global provider', () => {
		const scoped = provider({
			id: 's',
			matchRoute: (path) => path.startsWith('/dashboard/postbox'),
		});
		const global = provider({ id: 'g' });
		expect(
			activeProviders([global, scoped], [], gate([], '/dashboard/campaigns')).map((p) => p.id)
		).toEqual(['g']);
		expect(
			activeProviders([global, scoped], [], gate([], '/dashboard/postbox/inbox')).map((p) => p.id)
		).toEqual(['g', 's']);
	});

	it('does not call the flag oracle for providers without a flag', () => {
		const isFlagEnabled = vi.fn(() => true);
		activeProviders([provider({ id: 'x' })], [], { path: '/', isFlagEnabled });
		expect(isFlagEnabled).not.toHaveBeenCalled();
	});
});

describe('routePrefixMatcher', () => {
	const match = routePrefixMatcher('/dashboard/postbox');

	it('accepts the prefix exactly and any nested child path', () => {
		expect(match('/dashboard/postbox')).toBe(true);
		expect(match('/dashboard/postbox/inbox')).toBe(true);
		expect(match('/dashboard/postbox/search/results')).toBe(true);
	});

	it('rejects sibling routes that merely share the textual prefix', () => {
		expect(match('/dashboard/postbox-archive')).toBe(false);
		expect(match('/dashboard/postboxes')).toBe(false);
		expect(match('/dashboard/campaigns')).toBe(false);
		expect(match('/dashboard')).toBe(false);
	});
});

describe('collectProviderGroups', () => {
	it('outputs groups in provider order', () => {
		const groups = collectProviderGroups(
			[
				provider({ id: 'a', build: () => [group('ga', 0, [item('a1')])] }),
				provider({ id: 'b', build: () => [group('gb', 0, [item('b1')])] }),
			],
			{ query: '' }
		);
		expect(groups.map((g) => g.key)).toEqual(['ga', 'gb']);
	});

	it('drops a duplicate group key so the earlier provider wins', () => {
		const groups = collectProviderGroups(
			[
				provider({ id: 'a', build: () => [group('dup', 0, [item('a1', 'first')])] }),
				provider({ id: 'b', build: () => [group('dup', 0, [item('b1', 'second')])] }),
			],
			{ query: '' }
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.items.map((i) => i.label)).toEqual(['first']);
	});

	it('filters a duplicate item id across groups, keeping the first occurrence', () => {
		const groups = collectProviderGroups(
			[
				provider({ id: 'a', build: () => [group('ga', 0, [item('shared'), item('a-only')])] }),
				provider({ id: 'b', build: () => [group('gb', 1, [item('shared'), item('b-only')])] }),
			],
			{ query: '' }
		);
		expect(groups[0]?.items.map((i) => i.id)).toEqual(['shared', 'a-only']);
		expect(groups[1]?.items.map((i) => i.id)).toEqual(['b-only']);
	});

	it('passes empty groups through unchanged (mergeGroups drops them later)', () => {
		const groups = collectProviderGroups(
			[provider({ id: 'a', build: () => [group('empty', 0, [])] })],
			{ query: '' }
		);
		expect(groups).toEqual([group('empty', 0, [])]);
	});

	it('threads the query through to every provider build', () => {
		const seen: string[] = [];
		collectProviderGroups(
			[
				provider({ id: 'a', build: ({ query }) => (seen.push(query), []) }),
				provider({ id: 'b', build: ({ query }) => (seen.push(query), []) }),
			],
			{ query: 'acme' }
		);
		expect(seen).toEqual(['acme', 'acme']);
	});
});

describe('resolvePaletteGroups', () => {
	it('gates, orders, and dedups in one pass', () => {
		const core = [
			provider({ id: 'core', priority: 0, build: () => [group('nav', 40, [item('nav:home')])] }),
		];
		const external = [
			provider({
				id: 'plugin',
				priority: 100,
				flag: 'campaigns',
				build: () => [group('plugin', 5, [item('plugin:action')])],
			}),
			provider({
				id: 'offroute',
				priority: 1,
				matchRoute: (path) => path.startsWith('/other'),
				build: () => [group('offroute', 1, [item('nope')])],
			}),
		];
		// Flag off, wrong route → only the core provider survives.
		expect(
			resolvePaletteGroups(core, external, gate([], '/dashboard'), { query: '' }).map((g) => g.key)
		).toEqual(['nav']);
		// Flag on → the plugin joins, after core.
		expect(
			resolvePaletteGroups(core, external, gate(['campaigns'], '/dashboard'), { query: '' }).map(
				(g) => g.key
			)
		).toEqual(['nav', 'plugin']);
	});

	it('lets an external provider add work but never hijack a core group or item, even at lower priority', () => {
		const core = provider({
			id: 'core:navigation',
			priority: 50,
			build: () => [group('navigation', 40, [item('nav:inbox', 'Inbox')])],
		});
		const hostile = provider({
			id: 'plugin:evil',
			priority: -999, // tries to sort/run first
			build: () => [
				group('navigation', 40, [item('nav:inbox', 'Hijacked')]), // same key + id
				group('plugin', 1, [item('plugin:new', 'Legit addition')]),
			],
		});
		const groups = resolvePaletteGroups([core], [hostile], gate(), { query: '' });
		const navGroup = groups.find((g) => g.key === 'navigation');
		// Core's navigation group survives untouched; the hostile duplicate key/id
		// is dropped; only the genuinely-new plugin group is added.
		expect(navGroup?.items.map((i) => [i.id, i.label])).toEqual([['nav:inbox', 'Inbox']]);
		expect(groups.map((g) => g.key)).toEqual(['navigation', 'plugin']);
	});
});
