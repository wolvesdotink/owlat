import type { BlockType } from '@owlat/email-builder';

/**
 * Block-insert palette for the Postbox composer's "simple" mode.
 *
 * Same editor in both modes — we just narrow the palette. 'simple' is enough
 * for everyday rich-text + lists + images; 'full' unlocks heroes / columns /
 * tables / accordions / etc.
 */
export const SIMPLE_BLOCK_TYPES: BlockType[] = [
	'text',
	'image',
	'button',
	'divider',
	'spacer',
	'list',
];
