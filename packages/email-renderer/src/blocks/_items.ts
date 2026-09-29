/**
 * Shared walkers for the blocks that hold an `items` list of container
 * children (container, hero). Both degrade the same way in plaintext and AMP,
 * so the recursion and the padded AMP wrapper live here once.
 */

import type { ContainerItem } from '@owlat/shared';
import { itemToBlock, type PlaintextWalk } from './_module';
import { escapeCss } from '../sanitize';

/** Walk each item, drop the ones that render nothing. */
const walkItems = (items: readonly ContainerItem[], walk: PlaintextWalk): string[] =>
	items.map((item) => walk(itemToBlock(item))).filter(Boolean);

/** Plaintext for an items block: each non-empty child on its own line. */
export const walkItemsPlaintext = (items: readonly ContainerItem[], walk: PlaintextWalk): string =>
	walkItems(items, walk).join('\n');

export interface AmpPaddedItemsInput {
	items: readonly ContainerItem[];
	/** Background colour for the wrapper; omitted when empty. */
	background?: string;
	/** Resolved padding in px. The caller applies its own defaults. */
	padding: { top: number; right: number; bottom: number; left: number };
}

// Only a finite number reaches the style attribute; anything else renders 0.
const px = (value: unknown): number => {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
};

/**
 * AMP for an items block: a padded `<div>` around the walked children, empty
 * children skipped.
 */
export const ampPaddedItems = (
	{ items, background, padding }: AmpPaddedItemsInput,
	walk: PlaintextWalk
): string => {
	const bgStyle = background ? `background-color:${escapeCss(background)};` : '';
	const { top, right, bottom, left } = padding;
	const paddingCss = `padding:${px(top)}px ${px(right)}px ${px(bottom)}px ${px(left)}px`;
	return `<div style="${bgStyle}${paddingCss}">${walkItems(items, walk).join('\n')}</div>`;
};
