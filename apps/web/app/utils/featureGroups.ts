/**
 * How the Features screens (Settings → Features and the setup wizard's
 * features step) lay out the flag registry.
 *
 * The three feature packs are the main controls. Every individual flag sits
 * behind its pack's "Customize" disclosure; flags that belong to no pack
 * (integrations, security, deliverability, bundled plugins) share a fourth,
 * switchless "More features" group. This is a presentation grouping only: pack
 * membership — what a pack switch actually flips — stays `FEATURE_PACKS` in
 * `@owlat/shared/featureFlags`.
 */
import {
	ALL_FEATURE_PACK_KEYS,
	FEATURE_PACKS,
	getFlagsByCategory,
	type FeatureCategory,
	type FeatureFlagDefinition,
	type FeatureFlagRegistry,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';

export type FeatureGroupKey = FeaturePackKey | 'more';

export interface FeatureGroup {
	key: FeatureGroupKey;
	/** The pack this group's switch flips; `null` for the switchless "More features" group. */
	pack: FeaturePackKey | null;
	/** Categories the group spans, in registry order (for sub-headings in "More features"). */
	categories: FeatureCategory[];
	flags: FeatureFlagDefinition[];
}

/** Which group a flag category's flags are customized under. */
export const CATEGORY_GROUP: Record<FeatureCategory, FeatureGroupKey> = {
	receiving: 'emailClient',
	sending: 'marketing',
	ai: 'ai',
	integrations: 'more',
	security: 'more',
	deliverability: 'more',
	plugins: 'more',
	hosted: 'more',
};

const GROUP_ORDER: readonly FeatureGroupKey[] = [...ALL_FEATURE_PACK_KEYS, 'more'];

/**
 * Group the registry's flags under the pack they are customized with. Pack
 * members come first, in pack order, so the flags a pack switch flips lead its
 * list; the rest follow in registry order. A pack member filed under another
 * category still lands in its pack's group. Empty groups are dropped.
 */
export function groupFeatureFlags(
	registry: FeatureFlagRegistry,
	opts: { hosted?: boolean } = {}
): FeatureGroup[] {
	const packOf = new Map<string, FeaturePackKey>();
	for (const pack of ALL_FEATURE_PACK_KEYS) {
		for (const flag of FEATURE_PACKS[pack].flags) packOf.set(flag, pack);
	}

	const groups = new Map<FeatureGroupKey, FeatureGroup>(
		GROUP_ORDER.map((key) => [
			key,
			{ key, pack: key === 'more' ? null : key, categories: [], flags: [] },
		])
	);

	const byCategory = getFlagsByCategory({ registry, hosted: opts.hosted });
	for (const [category, defs] of Object.entries(byCategory) as [
		FeatureCategory,
		FeatureFlagDefinition[],
	][]) {
		for (const def of defs) {
			const group = groups.get(packOf.get(def.key) ?? CATEGORY_GROUP[category] ?? 'more')!;
			if (!group.categories.includes(category)) group.categories.push(category);
			group.flags.push(def);
		}
	}

	for (const group of groups.values()) {
		if (!group.pack) continue;
		const order = FEATURE_PACKS[group.pack].flags as readonly string[];
		const rank = (key: string) => {
			const i = order.indexOf(key);
			return i === -1 ? order.length : i;
		};
		// Stable sort keeps registry order among the non-members.
		group.flags = group.flags
			.map((def, index) => ({ def, index }))
			.sort((a, b) => rank(a.def.key) - rank(b.def.key) || a.index - b.index)
			.map(({ def }) => def);
	}

	return GROUP_ORDER.map((key) => groups.get(key)!).filter((group) => group.flags.length > 0);
}
