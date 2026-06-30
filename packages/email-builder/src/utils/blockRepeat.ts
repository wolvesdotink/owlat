import type { BlockRepeat } from '../types';

/**
 * Default item alias for a freshly-created repeat. The renderer substitutes
 * per-item placeholders as `{{itemAlias.key}}` (renderer.ts) with no fallback,
 * so an empty alias makes every `{{item.name}}`-style placeholder un-resolvable.
 * "item" matches the documented e-commerce example.
 */
export const DEFAULT_ITEM_ALIAS = 'item';

/**
 * Merge an edit into an existing (possibly partial) repeat config and return a
 * COMPLETE BlockRepeat. The renderer requires a non-empty `itemAlias` to build
 * the `{{itemAlias.key}}` substitution placeholders; if it is missing the loop
 * emits literal, un-substituted content. So we always emit `variable` +
 * `itemAlias`, defaulting the alias, and only keep `maxItems` when it is a
 * positive integer.
 */
export function normalizeRepeat(
	current: Partial<BlockRepeat> | undefined,
	patch: Partial<BlockRepeat>,
): BlockRepeat {
	const merged = { ...(current ?? {}), ...patch };
	const alias = merged.itemAlias?.trim();
	const next: BlockRepeat = {
		variable: merged.variable ?? '',
		itemAlias: alias && alias.length > 0 ? alias : DEFAULT_ITEM_ALIAS,
	};
	const maxItems = merged.maxItems;
	if (typeof maxItems === 'number' && Number.isFinite(maxItems) && maxItems >= 1) {
		next.maxItems = Math.floor(maxItems);
	}
	return next;
}
