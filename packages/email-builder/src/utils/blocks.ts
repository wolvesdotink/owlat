import type {
	BlockType,
	BlockContent,
	ColumnsBlockContent,
	ContainerBlockContent,
	ContainerItem,
	ColumnItem,
	EditorBlock,
	UniversalPadding,
	UniversalMargin,
	UniversalBorder,
	BorderStyle,
	EmailTheme,
	CommonBlockProperties,
} from '../types';
import {
	defaultPadding,
	defaultMargin,
	defaultBackgroundColor,
	defaultBorderRadius,
	defaultBorder,
	defaultTheme,
} from '../defaults';
import { getBlock } from '../registry';

/** Access common styling properties shared across all block content types. */
function getCommonProps(block: EditorBlock): CommonBlockProperties & Record<string, unknown> {
	return block.content as unknown as CommonBlockProperties & Record<string, unknown>;
}
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
	return def.createDefault({ ...defaultTheme, ...theme });
};

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
	return factory(mergedTheme) as ColumnItem['content'];
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
 * Get block padding with defaults for legacy blocks
 */
export const getBlockPadding = (block: EditorBlock): UniversalPadding => {
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
 * Update block padding
 */
export const updateBlockPadding = (
	block: EditorBlock,
	side: keyof UniversalPadding,
	value: number | boolean
): void => {
	const content = getCommonProps(block);
	if (side === 'paddingLinked') {
		content.paddingLinked = value as boolean;
	} else {
		content[side] = value as number;
		if (content.paddingLinked) {
			content.paddingTop = value as number;
			content.paddingRight = value as number;
			content.paddingBottom = value as number;
			content.paddingLeft = value as number;
		}
	}
};

/**
 * Toggle linked padding
 */
export const toggleLinkedPadding = (block: EditorBlock): void => {
	const content = block.content as CommonBlockProperties;
	const currentLinked = (content.paddingLinked as boolean | undefined) ?? false;
	content.paddingLinked = !currentLinked;

	if (!currentLinked) {
		const topValue = (content.paddingTop as number | undefined) ?? defaultPadding.paddingTop;
		content.paddingTop = topValue;
		content.paddingRight = topValue;
		content.paddingBottom = topValue;
		content.paddingLeft = topValue;
	}
};

/**
 * Get block margin with defaults
 */
export const getBlockMargin = (block: EditorBlock): UniversalMargin => {
	const content = block.content as CommonBlockProperties;
	return {
		marginTop: (content.marginTop as number | undefined) ?? defaultMargin.marginTop,
		marginRight: (content.marginRight as number | undefined) ?? defaultMargin.marginRight,
		marginBottom: (content.marginBottom as number | undefined) ?? defaultMargin.marginBottom,
		marginLeft: (content.marginLeft as number | undefined) ?? defaultMargin.marginLeft,
	};
};

/**
 * Update block margin
 */
export const updateBlockMargin = (
	block: EditorBlock,
	side: keyof UniversalMargin,
	value: number
): void => {
	const content = getCommonProps(block);
	content[side] = value;
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

/**
 * Get block border with defaults
 */
export const getBlockBorder = (block: EditorBlock): UniversalBorder => {
	const content = block.content as CommonBlockProperties;
	return {
		borderWidth: (content.borderWidth as number | undefined) ?? defaultBorder.borderWidth,
		borderColor: (content.borderColor as string | undefined) ?? defaultBorder.borderColor,
		borderStyle: (content.borderStyle as BorderStyle | undefined) ?? defaultBorder.borderStyle,
	};
};

/**
 * Update block border property
 */
export const updateBlockBorder = (
	block: EditorBlock,
	property: keyof UniversalBorder,
	value: number | string
): void => {
	const content = block.content as unknown as Record<string, unknown>;
	content[property] = value;
};

/**
 * Check if block has a visible border
 */
export const hasBlockBorder = (block: EditorBlock): boolean => {
	const border = getBlockBorder(block);
	return border.borderWidth > 0 && border.borderStyle !== 'none';
};

// Column-width math now lives in @owlat/shared so the editor preview and the
// renderer agree. Re-exported here to keep existing builder call sites working.
export { getColumnWidths } from '@owlat/shared';

/**
 * Regenerate IDs for container items (recursive)
 * Used when duplicating or inserting saved container blocks
 */
export const regenerateContainerItemIds = (items: ContainerItem[]): void => {
	for (const item of items) {
		item.id = generateId();
		if (item.type === 'container') {
			const containerContent = item.content as ContainerBlockContent;
			regenerateContainerItemIds(containerContent.items);
		} else if (item.type === 'columns') {
			const columnsContent = item.content as ColumnsBlockContent;
			regenerateColumnItemIds(columnsContent.columns);
		}
	}
};

/**
 * Regenerate IDs for column items (for all columns)
 */
export const regenerateColumnItemIds = (columns: ColumnItem[][]): void => {
	for (const column of columns) {
		for (const item of column) {
			item.id = generateId();
		}
	}
};

/**
 * Regenerate all nested IDs in a block's content
 * Call this when inserting a saved block to ensure unique IDs
 */
export const regenerateNestedBlockIds = (block: EditorBlock): void => {
	if (block.type === 'container') {
		const content = block.content as ContainerBlockContent;
		regenerateContainerItemIds(content.items);
	} else if (block.type === 'columns') {
		const content = block.content as ColumnsBlockContent;
		regenerateColumnItemIds(content.columns);
	}
};
