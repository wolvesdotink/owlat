/**
 * Ordered, deduplicated provider registry for the app command palette.
 *
 * The palette used to grow its "current surface" affordances from a single
 * shared `PaletteGroup[]` state bucket that exactly one surface could own at a
 * time — a second registrant clobbered the first, and there was no route/flag
 * gating or collision handling. This module replaces that bucket with a
 * registry of independent *providers*, each of which:
 *   - has a stable `id` (the dedup key — the first provider to claim an id wins,
 *     so a later contribution can never shadow or replace an earlier provider by
 *     reusing its id, even when the first one is currently gated off);
 *   - carries a `priority` that orders providers *within their trust tier*
 *     (lower first, ties broken on `id` for a total order);
 *   - may declare a feature `flag` and/or a `matchRoute` predicate; a provider
 *     that fails either gate contributes nothing but keeps its id reserved.
 *
 * Trust precedence is structural, not numeric: {@link resolvePaletteGroups}
 * takes *core* providers (built by the shell) and *external* providers
 * (registered by mounted surfaces and, later, plugins) as separate tiers and
 * always consults every core provider before any external one. An external
 * provider therefore can never out-prioritize a core provider or claim a core
 * group key / item id first — it may add work, never override it — regardless
 * of the `priority` it declares.
 *
 * Everything here is pure so the ordering, dedup, and gating rules can be
 * exercised deterministically without mounting the component. The reactive
 * registration wrapper lives in `~/composables/useCommandPaletteRegistry`.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { PaletteGroup } from './commandPalette';

/** Inputs a provider reads while building its groups for the current frame. */
export interface PaletteBuildContext {
	/** Current palette query (possibly empty). Providers filter their own items. */
	readonly query: string;
}

/** A named contributor of palette groups. Core surfaces and plugins alike. */
export interface CommandPaletteProvider {
	/** Stable identity and dedup key. The first provider to claim an id wins. */
	readonly id: string;
	/**
	 * Orders providers within their trust tier (lower is consulted earlier).
	 * Ties break on `id` so the order is total and deterministic. Precedence
	 * across tiers is structural — see the module doc — so this never lets an
	 * external provider jump ahead of a core one.
	 */
	readonly priority: number;
	/** When set, the provider is inert unless this feature flag is enabled. */
	readonly flag?: FeatureFlagKey;
	/**
	 * When set, the provider is inert unless it returns true for the active route
	 * path. Absent means the provider is global (contributes on every route).
	 */
	readonly matchRoute?: (path: string) => boolean;
	/** Build this provider's groups for the current query. */
	readonly build: (context: PaletteBuildContext) => PaletteGroup[];
}

/** Ambient inputs used to gate providers in or out of the active set. */
export interface PaletteGateContext {
	/** Active route path, matched against each provider's `matchRoute`. */
	readonly path: string;
	/** Feature-flag oracle, consulted for each provider's optional `flag`. */
	readonly isFlagEnabled: (flag: FeatureFlagKey) => boolean;
}

/** UTF-16 code-unit comparison — stable, locale-independent tie-break on `id`. */
function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build a `matchRoute` predicate that accepts `prefix` exactly or as a path
 * segment ancestor (`prefix` followed by `/`), but rejects sibling routes that
 * merely share a textual prefix. `routePrefixMatcher('/dashboard/postbox')`
 * accepts `/dashboard/postbox` and `/dashboard/postbox/inbox` but rejects
 * `/dashboard/postbox-archive`. Pure.
 */
export function routePrefixMatcher(prefix: string): (path: string) => boolean {
	return (path) => path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Resolve the ordered set of providers that may contribute this frame, core
 * tier first then external tier, each ordered by `(priority, id)`.
 *
 * Ids are claimed in consult order across both tiers, so every core id is
 * reserved before any external provider is considered: a later provider (in
 * either tier) that reuses an already-claimed id is dropped even when the first
 * claimant is currently gated off. A provider whose `flag` is disabled or whose
 * `matchRoute` rejects the active path is excluded (its id stays claimed).
 * Pure.
 */
export function activeProviders(
	core: readonly CommandPaletteProvider[],
	external: readonly CommandPaletteProvider[],
	gate: PaletteGateContext
): CommandPaletteProvider[] {
	const claimed = new Set<string>();
	const takeTier = (tier: readonly CommandPaletteProvider[]): CommandPaletteProvider[] => {
		const active: CommandPaletteProvider[] = [];
		for (const provider of tier) {
			if (claimed.has(provider.id)) continue;
			claimed.add(provider.id);
			if (provider.flag && !gate.isFlagEnabled(provider.flag)) continue;
			if (provider.matchRoute && !provider.matchRoute(gate.path)) continue;
			active.push(provider);
		}
		return active.sort(
			(left, right) => left.priority - right.priority || compareIds(left.id, right.id)
		);
	};
	// Claim + order core first, then external, so core always precedes external.
	const orderedCore = takeTier(core);
	const orderedExternal = takeTier(external);
	return [...orderedCore, ...orderedExternal];
}

/**
 * Build and merge the groups from an already-ordered provider set.
 *
 * Providers are consulted in the given order (see {@link activeProviders}), so
 * collisions resolve to the earlier provider: a group `key` already contributed
 * is dropped, and an item `id` already contributed is filtered out (a later
 * provider can add work, never re-emit or override an earlier entry). Empty
 * groups are preserved here and dropped downstream by `mergeGroups`. Pure.
 */
export function collectProviderGroups(
	providers: readonly CommandPaletteProvider[],
	context: PaletteBuildContext
): PaletteGroup[] {
	const seenGroupKeys = new Set<string>();
	const seenItemIds = new Set<string>();
	const groups: PaletteGroup[] = [];
	for (const provider of providers) {
		for (const group of provider.build(context)) {
			if (seenGroupKeys.has(group.key)) continue;
			seenGroupKeys.add(group.key);
			const items = group.items.filter((item) => {
				if (seenItemIds.has(item.id)) return false;
				seenItemIds.add(item.id);
				return true;
			});
			groups.push({ ...group, items });
		}
	}
	return groups;
}

/**
 * Gate, order, and collect provider groups in one pass, core tier before
 * external tier. The returned groups still need `mergeGroups` to sort by
 * `order`, drop empties, and cap. Pure.
 */
export function resolvePaletteGroups(
	core: readonly CommandPaletteProvider[],
	external: readonly CommandPaletteProvider[],
	gate: PaletteGateContext,
	context: PaletteBuildContext
): PaletteGroup[] {
	return collectProviderGroups(activeProviders(core, external, gate), context);
}
