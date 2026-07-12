import type { EditorBlock, CommonBlockProperties } from '@owlat/shared';
import { getColumnWidths } from '@owlat/shared';
import type { RenderContext } from '../types';
import type { BlockLayout } from '../blocks/_module';
import {
	getSectionPadding,
	getMarginOnlyPadding,
	getSectionBackground,
	getSectionBorder,
	getSectionBorderRadius,
} from './padding';
import { gradientToCss } from './gradient';

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
		classes.push(c.cssClass);
	}
	return classes;
};

/**
 * Get inline CSS custom properties for dark mode overrides.
 */
const getDarkModeVars = (block: EditorBlock): string => {
	const c = block.content as CommonBlockProperties;
	const vars: string[] = [];
	if (c.darkBackgroundColor) vars.push(`--dark-bg:${c.darkBackgroundColor}`);
	if (c.darkTextColor) vars.push(`--dark-text:${c.darkTextColor}`);
	return vars.length > 0 ? vars.join(';') + ';' : '';
};

/**
 * Get data attributes for per-block responsive font sizing.
 */
const getBlockDataAttrs = (block: EditorBlock): string => {
	const safeId = block.id.replace(/"/g, '&quot;');
	return ` data-block-id="${safeId}"`;
};

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
		(layout?.sectionMode === 'outer-only'
			? getMarginOnlyPadding(block.content)
			: getSectionPadding(block.content));
	const bgColor = layout?.background ?? getSectionBackground(block.content);
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
	const gradientCss =
		layout?.gradient ?? (gradient && gradient.stops?.length >= 2 ? gradientToCss(gradient) : '');
	if (gradientCss) {
		tableStyles.push(`background:${gradientCss}`);
	}
	if (border.width > 0 && border.style !== 'none') {
		tableStyles.push(`border:${border.width}px ${border.style} ${border.color}`);
	}
	if (borderRadius > 0) tableStyles.push(`border-radius:${borderRadius}px`);

	const tableStyleAttr = tableStyles.length > 0 ? ` style="${tableStyles.join(';')}"` : '';
	const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
	const dataAttrs = getBlockDataAttrs(block);

	const sectionTable = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${tableStyleAttr}${classAttr}${dataAttrs}><tr><td style="padding:${padding};font-family:${ctx.theme.fontFamily}">${innerHtml}</td></tr></table>`;

	if (isFullWidth) {
		// Full-width: outer table at 100% width with background, inner content at baseWidth
		const outerBg = bgColor ? ` style="background-color:${bgColor}"` : '';
		return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${outerBg}${classAttr}${dataAttrs}><tr><td align="center"><table width="${ctx.baseWidth}" cellpadding="0" cellspacing="0" border="0" role="presentation" class="owlat-full-width-inner"><tr><td style="padding:${padding};font-family:${ctx.theme.fontFamily}">${innerHtml}</td></tr></table></td></tr></table>`;
	}

	return sectionTable;
};

/**
 * Wraps column content in a table cell with proper width.
 */
export const wrapColumnCell = (width: string, innerHtml: string): string => {
	return `<td style="width:${width};vertical-align:top;padding:0">${innerHtml || '&nbsp;'}</td>`;
};

/**
 * Wraps a block's HTML in the column-item shell used at column/container placement
 * by most blocks (the outer `<table><tr><td style="padding:8px 0">` wrapper).
 * Blocks that need different shells (text fuses styles, spacer is the cell)
 * don't use this helper.
 */
export const wrapColumnItem = (innerHtml: string): string =>
	`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:8px 0">${innerHtml}</td></tr></table>`;
