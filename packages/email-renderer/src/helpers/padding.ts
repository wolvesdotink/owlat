import type { EditorBlock, BorderStyle, CommonBlockProperties } from '@owlat/shared';
import { DEFAULT_BLOCK_MARGIN, DEFAULT_BLOCK_PADDING } from '@owlat/shared/emailDefaults';

const DEFAULT_PADDING = {
	top: DEFAULT_BLOCK_PADDING.paddingTop,
	right: DEFAULT_BLOCK_PADDING.paddingRight,
	bottom: DEFAULT_BLOCK_PADDING.paddingBottom,
	left: DEFAULT_BLOCK_PADDING.paddingLeft,
};
const DEFAULT_MARGIN = {
	top: DEFAULT_BLOCK_MARGIN.marginTop,
	right: DEFAULT_BLOCK_MARGIN.marginRight,
	bottom: DEFAULT_BLOCK_MARGIN.marginBottom,
	left: DEFAULT_BLOCK_MARGIN.marginLeft,
};
const DEFAULT_BORDER = { width: 0, color: '#000000', style: 'none' as BorderStyle };

export const getSectionPadding = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const paddingTop = c.paddingTop ?? DEFAULT_PADDING.top;
	const paddingRight = c.paddingRight ?? DEFAULT_PADDING.right;
	const paddingBottom = c.paddingBottom ?? DEFAULT_PADDING.bottom;
	const paddingLeft = c.paddingLeft ?? DEFAULT_PADDING.left;
	const marginTop = c.marginTop ?? DEFAULT_MARGIN.top;
	const marginRight = c.marginRight ?? DEFAULT_MARGIN.right;
	const marginBottom = c.marginBottom ?? DEFAULT_MARGIN.bottom;
	const marginLeft = c.marginLeft ?? DEFAULT_MARGIN.left;
	const top = paddingTop + marginTop;
	const right = paddingRight + marginRight;
	const bottom = paddingBottom + marginBottom;
	const left = paddingLeft + marginLeft;
	return `${top}px ${right}px ${bottom}px ${left}px`;
};

/**
 * Default section background — `content.backgroundColor`, with the
 * `'transparent'` sentinel coerced to empty so the table style isn't emitted.
 *
 * Block modules that source the section bg from a different field (e.g. button
 * reads `blockBackgroundColor` because its `backgroundColor` is the button's
 * fill) declare `layout()` to override this default. See
 * `BlockModule.layout?()` in `../blocks/_module.ts`.
 */
export const getSectionBackground = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const bgColor = c.backgroundColor;
	if (bgColor && bgColor !== 'transparent') {
		return bgColor;
	}
	return '';
};

/**
 * Margin-only padding for blocks that own their inner padding directly (e.g.
 * `hero` paints a background image flush to the section's outer table edges).
 * The Walker invokes this when `layout()` returns `sectionMode: 'outer-only'`.
 */
export const getMarginOnlyPadding = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const top = c.marginTop ?? DEFAULT_MARGIN.top;
	const right = c.marginRight ?? DEFAULT_MARGIN.right;
	const bottom = c.marginBottom ?? DEFAULT_MARGIN.bottom;
	const left = c.marginLeft ?? DEFAULT_MARGIN.left;
	return `${top}px ${right}px ${bottom}px ${left}px`;
};

export const getSectionBorder = (
	block: EditorBlock
): { width: number; style: BorderStyle; color: string } => {
	const c = block.content as CommonBlockProperties;
	const borderWidth = c.borderWidth ?? DEFAULT_BORDER.width;
	const borderStyle = c.borderStyle ?? DEFAULT_BORDER.style;
	const borderColor = c.borderColor ?? DEFAULT_BORDER.color;
	return { width: borderWidth, style: borderStyle, color: borderColor };
};

export const getSectionBorderRadius = (block: EditorBlock): number => {
	const c = block.content as CommonBlockProperties;
	return c.borderRadius ?? 0;
};
