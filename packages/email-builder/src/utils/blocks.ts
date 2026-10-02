import type {
	BlockType,
	BlockContent,
	ColumnItem,
	EditorBlock,
	UniversalPadding,
	UniversalMargin,
	EmailTheme,
	CommonBlockProperties,
	ImageBlockContent,
	ImageUploadResult,
} from '../types';
import {
	defaultPadding,
	defaultMargin,
	defaultBackgroundColor,
	defaultBorderRadius,
	defaultTheme,
} from '../defaults';
import { getBlock } from '../registry';
import { generateId } from './id';

/**
 * Create default content for block types.
 * Delegates to the registry's createDefault factory.
 */
export const createDefaultContent = (
	type: BlockType,
	theme: EmailTheme = defaultTheme
): BlockContent => {
	const def = getBlock(type);
	if (!def) throw new Error(`Unknown block type: ${type}`);
	const mergedTheme = { ...defaultTheme, ...theme };
	return withThemeBlockDefaults(type, def.createDefault(mergedTheme), mergedTheme);
};

/**
 * Lay the theme's per-type defaults (`blockDefaults`, set by the brand kit)
 * over a new Block's content, so a Block starts in the brand's colours and
 * button style. The default theme has none, so without a kit nothing changes.
 */
function withThemeBlockDefaults<C>(type: BlockType, content: C, theme: EmailTheme): C {
	const overlay = theme.blockDefaults?.[type];
	return overlay ? { ...content, ...overlay } : content;
}

/**
 * Create default content for a column-context block.
 *
 * Delegates to the block registry: prefers `createDefaultColumnItem` (compact
 * column-optimized defaults) when defined, otherwise falls back to the
 * top-level `createDefault` factory. Third-party blocks marked
 * `canBeInColumn: true` automatically work here.
 */
export const createDefaultColumnItemContent = (
	type: ColumnItem['type'],
	theme: EmailTheme = defaultTheme
): ColumnItem['content'] => {
	const def = getBlock(type);
	if (!def) throw new Error(`Unknown column item type: ${type}`);
	if (!def.canBeInColumn) throw new Error(`Block "${type}" cannot be used inside a column`);
	const mergedTheme = { ...defaultTheme, ...theme };
	const factory = def.createDefaultColumnItem ?? def.createDefault;
	return withThemeBlockDefaults(type, factory(mergedTheme), mergedTheme) as ColumnItem['content'];
};

/**
 * Create a new block with generated ID
 */
export const createBlock = (type: BlockType, theme?: EmailTheme): EditorBlock => {
	return {
		id: generateId('block'),
		type,
		content: createDefaultContent(type, theme),
	} as EditorBlock;
};

/**
 * Pair an uploaded image's render URL with its durable storage identity.
 *
 * The URL is a short-lived capability used by the preview. Matching storage
 * and media-asset identities are the durable source of truth used by export
 * and other byte-exact workflows.
 */
export const withPrimaryStoredImage = (
	content: ImageBlockContent,
	result: ImageUploadResult
): ImageBlockContent => ({
	...content,
	src: result.url,
	storageId: result.storageId,
	mediaAssetId: result.mediaAssetId,
});

/**
 * Create a new column item with generated ID
 */
export const createColumnItem = (type: ColumnItem['type'], theme?: EmailTheme): ColumnItem => {
	return {
		id: generateId(),
		type,
		content: createDefaultColumnItemContent(type, theme),
	};
};

/**
 * Get block padding with defaults for legacy blocks. `paddingLinked` is
 * carried through for stored documents; no editor control reads or writes it.
 */
export const getBlockPadding = (block: Pick<EditorBlock, 'content'>): UniversalPadding => {
	const content = block.content as CommonBlockProperties;
	return {
		paddingTop: (content.paddingTop as number | undefined) ?? defaultPadding.paddingTop,
		paddingRight: (content.paddingRight as number | undefined) ?? defaultPadding.paddingRight,
		paddingBottom: (content.paddingBottom as number | undefined) ?? defaultPadding.paddingBottom,
		paddingLeft: (content.paddingLeft as number | undefined) ?? defaultPadding.paddingLeft,
		paddingLinked: (content.paddingLinked as boolean | undefined) ?? defaultPadding.paddingLinked,
	};
};

/**
 * Get block margin with defaults
 */
export const getBlockMargin = (block: Pick<EditorBlock, 'content'>): UniversalMargin => {
	const content = block.content as CommonBlockProperties;
	return {
		marginTop: (content.marginTop as number | undefined) ?? defaultMargin.marginTop,
		marginRight: (content.marginRight as number | undefined) ?? defaultMargin.marginRight,
		marginBottom: (content.marginBottom as number | undefined) ?? defaultMargin.marginBottom,
		marginLeft: (content.marginLeft as number | undefined) ?? defaultMargin.marginLeft,
	};
};

/** Inline padding and margin longhands of a block's canvas wrapper, in px. */
interface BlockBoxStyle {
	paddingTop: string;
	paddingRight: string;
	paddingBottom: string;
	paddingLeft: string;
	marginTop: string;
	marginRight: string;
	marginBottom: string;
	marginLeft: string;
}

/**
 * The padding and margin a canvas preview paints around a block, with the
 * shared block defaults filling any side the content leaves unset, so the
 * editor box matches the renderer's section padding. Pass `{ content }` when
 * the preview renders theme-merged content rather than the raw block.
 */
export const blockBoxStyle = (block: Pick<EditorBlock, 'content'>): BlockBoxStyle => {
	const padding = getBlockPadding(block);
	const margin = getBlockMargin(block);
	return {
		paddingTop: `${padding.paddingTop}px`,
		paddingRight: `${padding.paddingRight}px`,
		paddingBottom: `${padding.paddingBottom}px`,
		paddingLeft: `${padding.paddingLeft}px`,
		marginTop: `${margin.marginTop}px`,
		marginRight: `${margin.marginRight}px`,
		marginBottom: `${margin.marginBottom}px`,
		marginLeft: `${margin.marginLeft}px`,
	};
};

/**
 * Get block background color
 */
export const getBlockBackgroundColor = (block: EditorBlock): string => {
	const content = block.content as CommonBlockProperties;
	if (block.type === 'button') {
		return (content.blockBackgroundColor as string | undefined) ?? defaultBackgroundColor;
	}
	return (content.backgroundColor as string | undefined) ?? defaultBackgroundColor;
};

/**
 * Update block background color
 */
export const updateBlockBackgroundColor = (block: EditorBlock, color: string): void => {
	const content = block.content as CommonBlockProperties;
	if (block.type === 'button') {
		content.blockBackgroundColor = color;
	} else {
		content.backgroundColor = color;
	}
};

/**
 * Check if a block supports border radius.
 * Derived from the block registry.
 */
export const blockSupportsBorderRadius = (block: EditorBlock): boolean => {
	return getBlock(block.type)?.supportsBorderRadius ?? false;
};

/**
 * Get block border radius
 */
export const getBlockBorderRadius = (block: EditorBlock): number => {
	if (!blockSupportsBorderRadius(block)) return 0;
	const content = block.content as CommonBlockProperties;
	return (content.borderRadius as number | undefined) ?? defaultBorderRadius;
};

/**
 * Update block border radius
 */
export const updateBlockBorderRadius = (block: EditorBlock, value: number): void => {
	if (!blockSupportsBorderRadius(block)) return;
	const content = block.content as CommonBlockProperties;
	content.borderRadius = value;
};

// Column-width math now lives in @owlat/shared so the editor preview and the
// renderer agree. Re-exported here to keep existing builder call sites working.
export { getColumnWidths } from '@owlat/shared';
