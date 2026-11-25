import type { EditorBlock, CommonBlockProperties } from '@owlat/shared';
import { getColumnWidths } from '@owlat/shared';
import type { RenderContext } from '../types';
import type { BlockLayout } from '../blocks/_module';
import {
	getSectionPadding,
	getSectionMargin,
	getNestedItemPadding,
	getSectionBackground,
	getSectionBorder,
	getSectionBorderRadius,
	px,
} from './padding';
import { gradientToCss } from './gradient';
import { escapeAttr, escapeCss } from '../sanitize';

// Re-exported from @owlat/shared so existing renderer call sites keep importing
// it from here; the implementation is shared with the editor half of the
// columns Block module.
export { getColumnWidths };

/**
 * Get CSS classes for responsive visibility, dark mode overrides, and custom CSS class.
 */
const getBlockClasses = (block: EditorBlock): string[] => {
	const classes: string[] = [];
	const c = block.content as CommonBlockProperties;
	if (c.hideOnMobile) classes.push('owlat-hide-mobile');
	if (c.hideOnDesktop) classes.push('owlat-hide-desktop');
	if (c.darkBackgroundColor) classes.push('owlat-dark-bg');
	if (c.darkTextColor) classes.push('owlat-dark-text');
	if (c.cssClass && typeof c.cssClass === 'string') {
		classes.push(escapeAttr(c.cssClass));
	}
	return classes;
};

/**
 * Get inline CSS custom properties for dark mode overrides.
 */
const getDarkModeVars = (block: EditorBlock): string => {
	const c = block.content as CommonBlockProperties;
	const vars: string[] = [];
	if (c.darkBackgroundColor) vars.push(`--dark-bg:${escapeCss(c.darkBackgroundColor)}`);
	if (c.darkTextColor) vars.push(`--dark-text:${escapeCss(c.darkTextColor)}`);
	return vars.length > 0 ? vars.join(';') + ';' : '';
};

/**
 * Get data attributes for per-block responsive font sizing. A Block without a
 * string id (stored data from a direct caller is not trusted) renders
 * without the attribute instead of failing the whole render.
 */
export const getBlockDataAttrs = (block: Pick<EditorBlock, 'id'>): string => {
	const id: unknown = block.id;
	if (typeof id !== 'string') return '';
	return ` data-block-id="${escapeAttr(id)}"`;
};

/**
 * A collapsed table border ignores `border-radius`, so a table that carries a
 * radius opts out of the `border-collapse:collapse!important` reset in
 * `styles.ts`. Only an inline `!important` outranks that rule.
 */
export const SEPARATE_BORDERS = 'border-collapse:separate!important';

/**
 * Wraps block content in a section table with padding, background, and border.
 * Supports full-width mode where the section spans the full viewport.
 *
 * The optional `layout` descriptor lets a Block module override Walker defaults
 * without the Walker switching on `block.type`. Today: button overrides
 * `background` (its `backgroundColor` is the button's fill, not the section's);
 * hero sets `sectionMode: 'outer-only'` so its background image flows to the
 * outer table edges. See `BlockModule.layout?()` in `../blocks/_module.ts`.
 */
export const wrapSection = (
	block: EditorBlock,
	innerHtml: string,
	ctx: RenderContext,
	layout?: BlockLayout
): string => {
	const padding =
		layout?.padding ??
		(layout?.sectionMode === 'outer-only' ? '0px 0px 0px 0px' : getSectionPadding(block.content));
	const margin = getSectionMargin(block.content);
	const bgColor = escapeCss(layout?.background ?? getSectionBackground(block.content));
	const border = getSectionBorder(block);
	const borderRadius = layout?.borderRadius ?? getSectionBorderRadius(block);
	const classes = getBlockClasses(block);
	const c = block.content as CommonBlockProperties;
	const isFullWidth = c.fullWidth === true;

	const darkModeVars = getDarkModeVars(block);
	const tableStyles: string[] = [];
	if (darkModeVars) tableStyles.push(darkModeVars);
	if (bgColor) tableStyles.push(`background-color:${bgColor}`);
	const gradient = c.backgroundGradient;
	const gradientCss = escapeCss(
		layout?.gradient ?? (gradient && gradient.stops?.length >= 2 ? gradientToCss(gradient) : '')
	);
	if (gradientCss) {
		tableStyles.push(`background:${gradientCss}`);
	}
	if (border.width > 0 && border.style !== 'none') {
		tableStyles.push(
			`border:${border.width}px ${escapeCss(border.style)} ${escapeCss(border.color)}`
		);
	}
	if (borderRadius > 0) {
		tableStyles.push(`border-radius:${borderRadius}px`);
		tableStyles.push(SEPARATE_BORDERS);
	}

	const tableStyleAttr = tableStyles.length > 0 ? ` style="${tableStyles.join(';')}"` : '';
	// With a margin cell around the section, hiding on one viewport hides that
	// cell, so the margin goes with the block. Every other class stays on the
	// table that carries the background.
	const visibility: string[] = margin
		? classes.filter((cls) => cls === 'owlat-hide-mobile' || cls === 'owlat-hide-desktop')
		: [];
	const boxClasses = classes.filter((cls) => !visibility.includes(cls));
	const classAttr = boxClasses.length > 0 ? ` class="${boxClasses.join(' ')}"` : '';
	const dataAttrs = getBlockDataAttrs(block);
	const fontFamily = escapeCss(ctx.theme.fontFamily);

	let section: string;
	if (isFullWidth) {
		// Full-width: outer table at 100% width with background, inner content at baseWidth
		const outerBg = bgColor ? ` style="background-color:${bgColor}"` : '';
		// Inside a margin cell the content is narrower than the base width, so
		// a fixed-width inner table would overflow the margin.
		const innerWidth = margin ? '100%' : `${px(ctx.baseWidth, 0)}`;
		section = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${outerBg}${classAttr}${dataAttrs}><tr><td align="center"><table width="${innerWidth}" cellpadding="0" cellspacing="0" border="0" role="presentation" class="owlat-full-width-inner"><tr><td style="padding:${padding};font-family:${fontFamily}">${innerHtml}</td></tr></table></td></tr></table>`;
	} else {
		section = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${tableStyleAttr}${classAttr}${dataAttrs}><tr><td style="padding:${padding};font-family:${fontFamily}">${innerHtml}</td></tr></table>`;
	}

	if (!margin) return section;
	const marginClassAttr = visibility.length > 0 ? ` class="${visibility.join(' ')}"` : '';
	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${marginClassAttr}><tr><td style="padding:${margin}">${section}</td></tr></table>`;
};

/** What a nested item's module adds to the shell `wrapNestedItem` draws. */
export interface NestedItemShell {
	/** Background colour of the item's box. Omit to read `content.backgroundColor`. */
	background?: string;
	/** Corner radius of the item's box. Omit to read `content.borderRadius`. */
	borderRadius?: number;
	/** Declarations appended to the cell's padding, such as fused text styles. */
	cellStyle?: string;
	/** Attributes written on the cell, each with its leading space. */
	cellAttrs?: string;
}

/**
 * Wraps a nested item's HTML (a column or container child) in its cell: the
 * item's padding (see `getNestedItemPadding`), and its background, border and
 * corner radius on the table around the cell. A margin goes in a further cell
 * outside that table, as `wrapSection` does for a root block. An item that
 * sets none of these renders as `<table><tr><td style="padding:8px 0">`.
 *
 * The radius is drawn only with a background or border to round, so a nested
 * image's radius, which also rounds the image, adds nothing invisible.
 */
export const wrapNestedItem = (
	content: EditorBlock['content'],
	innerHtml: string,
	shell: NestedItemShell = {}
): string => {
	// Nested items ignored these fields until they were drawn, so stored data
	// may hold a non-string colour; it is skipped instead of failing the render.
	const background = shell.background ?? getSectionBackground(content);
	const bgColor = typeof background === 'string' ? escapeCss(background) : '';
	const border = getSectionBorder({ content } as EditorBlock);
	const hasBorder =
		border.width > 0 &&
		border.style !== 'none' &&
		typeof border.style === 'string' &&
		typeof border.color === 'string';
	const borderRadius = shell.borderRadius ?? getSectionBorderRadius({ content } as EditorBlock);

	const tableStyles: string[] = [];
	if (bgColor) tableStyles.push(`background-color:${bgColor}`);
	if (hasBorder) {
		tableStyles.push(
			`border:${border.width}px ${escapeCss(border.style)} ${escapeCss(border.color)}`
		);
	}
	if (borderRadius > 0 && (bgColor || hasBorder)) {
		tableStyles.push(`border-radius:${borderRadius}px`);
		tableStyles.push(SEPARATE_BORDERS);
	}
	const tableStyleAttr = tableStyles.length > 0 ? ` style="${tableStyles.join(';')}"` : '';
	const cellStyle = shell.cellStyle
		? `padding:${getNestedItemPadding(content)};${shell.cellStyle}`
		: `padding:${getNestedItemPadding(content)}`;
	const item = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${tableStyleAttr}><tr><td${shell.cellAttrs ?? ''} style="${cellStyle}">${innerHtml}</td></tr></table>`;

	const margin = getSectionMargin(content);
	if (!margin) return item;
	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:${margin}">${item}</td></tr></table>`;
};
