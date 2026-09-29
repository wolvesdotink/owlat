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

/**
 * Coerce a numeric style field to a finite number, or `fallback`.
 *
 * Block content is stored as JSON, so a field typed `number` can hold any
 * value at render time. Every numeric value interpolated into a `style`
 * attribute or a sizing attribute goes through this helper. Numeric strings
 * ("12") are accepted; everything else (other strings, NaN, Infinity,
 * booleans, objects, null, undefined) yields the fallback.
 */
export function px(value: unknown, fallback: number): number;
export function px(value: unknown, fallback: number | undefined): number | undefined;
export function px(value: unknown, fallback: number | undefined): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	}
	return fallback;
}

export const getSectionPadding = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const paddingTop = px(c.paddingTop, DEFAULT_PADDING.top);
	const paddingRight = px(c.paddingRight, DEFAULT_PADDING.right);
	const paddingBottom = px(c.paddingBottom, DEFAULT_PADDING.bottom);
	const paddingLeft = px(c.paddingLeft, DEFAULT_PADDING.left);
	const marginTop = px(c.marginTop, DEFAULT_MARGIN.top);
	const marginRight = px(c.marginRight, DEFAULT_MARGIN.right);
	const marginBottom = px(c.marginBottom, DEFAULT_MARGIN.bottom);
	const marginLeft = px(c.marginLeft, DEFAULT_MARGIN.left);
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
	const top = px(c.marginTop, DEFAULT_MARGIN.top);
	const right = px(c.marginRight, DEFAULT_MARGIN.right);
	const bottom = px(c.marginBottom, DEFAULT_MARGIN.bottom);
	const left = px(c.marginLeft, DEFAULT_MARGIN.left);
	return `${top}px ${right}px ${bottom}px ${left}px`;
};

export const getSectionBorder = (
	block: EditorBlock
): { width: number; style: BorderStyle; color: string } => {
	const c = block.content as CommonBlockProperties;
	const borderWidth = px(c.borderWidth, DEFAULT_BORDER.width);
	const borderStyle = c.borderStyle ?? DEFAULT_BORDER.style;
	const borderColor = c.borderColor ?? DEFAULT_BORDER.color;
	return { width: borderWidth, style: borderStyle, color: borderColor };
};

export const getSectionBorderRadius = (block: EditorBlock): number => {
	const c = block.content as CommonBlockProperties;
	return px(c.borderRadius, 0);
};
