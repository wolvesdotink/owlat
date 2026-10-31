/**
 * Feature packs.
 *
 * A FeaturePack is a UI grouping over atomic flags so users can toggle a whole
 * product surface (e.g. "Email Client") in one click. Packs do not introduce
 * new state — they read and write the same `FeatureFlagState`, reusing the
 * existing `applyToggle` cascade.
 *
 * Import from `featureFlags.ts`, which re-exports everything here.
 */

import {
	resolveFlags,
	type CoreFeatureFlagKey,
	type FeatureFlagKey,
	type FeatureFlagState,
} from './featureFlagRuntime';
import {
	applyToggle,
	registeredFeatureFlagOverrides,
	type FeatureFlagRegistry,
} from './featureFlagRegistry';

export type FeaturePackKey = 'emailClient' | 'marketing' | 'ai';

export interface FeaturePack {
	key: FeaturePackKey;
	/** English name; the web renders `sharedPkg.featureFlags.packs.<key>.label`. */
	label: string;
	/** English description; the web renders `sharedPkg.featureFlags.packs.<key>.description`. */
	description: string;
	flags: readonly CoreFeatureFlagKey[];
}

export const FEATURE_PACKS: Record<FeaturePackKey, FeaturePack> = {
	emailClient: {
		key: 'emailClient',
		label: 'Email client',
		description: 'Inbox, chat, and personal mail (Postbox) as one bundle.',
		flags: ['inbox', 'chat', 'postbox', 'calendar.booking'],
	},
	marketing: {
		key: 'marketing',
		label: 'Marketing',
		description: 'Campaigns, automations, and the transactional API.',
		flags: ['campaigns', 'automations', 'transactional'],
	},
	ai: {
		key: 'ai',
		label: 'AI',
		description:
			'Reply drafts, auto-send rules, a knowledge graph, an assistant and AI dashboards.',
		flags: [
			'ai',
			'ai.agent',
			'ai.autonomy',
			'ai.knowledge',
			'ai.knowledge.autoLink',
			'ai.knowledge.graphRetrieval',
			'ai.knowledge.analytics',
			'ai.assistant',
			'ai.visualizations',
		],
	},
};

export const ALL_FEATURE_PACK_KEYS = Object.keys(FEATURE_PACKS) as FeaturePackKey[];

export type PackState = 'on' | 'off' | 'partial';

/**
 * Returns 'on' if every flag in the pack is enabled, 'off' if every flag is
 * disabled, or 'partial' otherwise. Resolves flags through `resolveFlags`
 * so dependency cascades are honored.
 */
export function isPackEnabled(
	stored: FeatureFlagState,
	packKey: FeaturePackKey,
	opts: { hosted?: boolean } = {}
): PackState {
	const pack = FEATURE_PACKS[packKey];
	const resolved = resolveFlags(stored, opts);
	let on = 0;
	let off = 0;
	for (const flag of pack.flags) {
		if (resolved[flag]) on++;
		else off++;
	}
	if (on === pack.flags.length) return 'on';
	if (off === pack.flags.length) return 'off';
	return 'partial';
}

/**
 * Toggle every flag in the pack to `value`, reusing `applyToggle` for each so
 * cascade rules apply. Returns the final state and the union of cascaded
 * sibling flags (excluding the pack members themselves).
 */
export function applyPackToggle(
	stored: FeatureFlagState,
	packKey: FeaturePackKey,
	value: boolean,
	registry: FeatureFlagRegistry
): { next: FeatureFlagState; cascaded: FeatureFlagKey[] } {
	const pack = FEATURE_PACKS[packKey];
	const packFlags = new Set<FeatureFlagKey>(pack.flags);
	let next: FeatureFlagState = registeredFeatureFlagOverrides(stored, registry);
	const cascaded = new Set<FeatureFlagKey>();
	for (const flag of pack.flags) {
		const result = applyToggle(next, flag, value, registry);
		next = result.next;
		for (const c of result.cascaded) {
			if (!packFlags.has(c)) cascaded.add(c);
		}
	}
	return { next, cascaded: Array.from(cascaded) };
}
