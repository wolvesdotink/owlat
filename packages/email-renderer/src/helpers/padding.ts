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

/**
 * A block's own padding. Its margin is not part of it: `wrapSection` draws the
 * margin in a cell outside the table that carries the background and border.
 */
export const getSectionPadding = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const top = px(c.paddingTop, DEFAULT_PADDING.top);
	const right = px(c.paddingRight, DEFAULT_PADDING.right);
	const bottom = px(c.paddingBottom, DEFAULT_PADDING.bottom);
	const left = px(c.paddingLeft, DEFAULT_PADDING.left);
	return `${top}px ${right}px ${bottom}px ${left}px`;
};

/**
 * The CSS padding of the cell that holds a block's margin, or `null` when the
 * block has no margin, so a block without one keeps a single table.
 */
export const getSectionMargin = (content: EditorBlock['content']): string | null => {
	const c = content as CommonBlockProperties;
	const top = px(c.marginTop, DEFAULT_MARGIN.top);
	const right = px(c.marginRight, DEFAULT_MARGIN.right);
	const bottom = px(c.marginBottom, DEFAULT_MARGIN.bottom);
	const left = px(c.marginLeft, DEFAULT_MARGIN.left);
	if (top === 0 && right === 0 && bottom === 0 && left === 0) return null;
	return `${top}px ${right}px ${bottom}px ${left}px`;
};

/** Padding of a nested item that sets none of its own. */
const NESTED_ITEM_PADDING = '8px 0';

/**
 * Padding sets the editor writes into every new nested item: a column item
 * gets the vertical block padding with no sides, a container item the full
 * root default. The renderer drew `8px 0` for nested items whatever they
 * stored, so these sets still mean "not set" and keep that padding; reading
 * them as set would move every existing email.
 */
const EDITOR_NESTED_PADDINGS: readonly (readonly number[])[] = [
	[DEFAULT_PADDING.top, DEFAULT_PADDING.right, DEFAULT_PADDING.bottom, DEFAULT_PADDING.left],
	[DEFAULT_PADDING.top, 0, DEFAULT_PADDING.bottom, 0],
];

/**
 * The CSS padding of a nested item's cell: its own padding when it sets one
 * that differs from the editor's defaults, otherwise `8px 0`. A side it leaves
 * unset takes its value from `8px 0`.
 */
export const getNestedItemPadding = (content: EditorBlock['content']): string => {
	const c = content as CommonBlockProperties;
	const sides = [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map((v) =>
		px(v, undefined)
	);
	if (sides.every((side) => side === undefined)) return NESTED_ITEM_PADDING;
	if (EDITOR_NESTED_PADDINGS.some((set) => set.every((value, i) => sides[i] === value))) {
		return NESTED_ITEM_PADDING;
	}
	const [top = 8, right = 0, bottom = 8, left = 0] = sides;
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
