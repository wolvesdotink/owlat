/**
 * Block module: container.
 *
 * Wraps a group of items in an MSO-fixed-width table with background, border,
 * border-radius, and optional background image (VML for Outlook). At root
 * placement, the Walker's `wrapSection` already handles padding/bg/border,
 * so the container module just concatenates children. At container placement
 * (nested), the module emits the full nested wrapping itself.
 *
 * Children are dispatched via `args.walk` at the `container` placement.
 */

import { fullSupport, type ContainerBlockContent, type EditorBlock } from '@owlat/shared';
import { itemToBlock, type BlockModule, type Placement } from '../_module';
import { toPixelWidth } from '../../helpers/dimensions';
import { gradientToCssOrEmpty } from '../../helpers/gradient';
import { msoVmlBackground, msoVmlBackgroundClose } from '../../outlook';
import { escapeCss, escapeCssUrl } from '../../sanitize';
import { backgroundImageCss } from '../../helpers/inline-styles';
import { checkShape, checkGradientStopLimit, isString, isNumber, isArray, isObject, isOneOf } from '../../helpers/validation';

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'none'] as const;

const renderRoot = (
	content: ContainerBlockContent,
	ctx: { baseWidth: number },
	walk: (child: EditorBlock, w: number, p: 'container') => string,
): string => {
	const maxWidthPercent = content.maxWidth ?? 100;
	const effectiveWidth = toPixelWidth(maxWidthPercent, ctx.baseWidth);
	return content.items
		.map((item) => walk(itemToBlock(item), effectiveWidth, 'container'))
		.filter(Boolean)
		.join('');
};

const renderNested = (
	content: ContainerBlockContent,
	baseWidth: number,
	walk: (child: EditorBlock, w: number, p: 'container') => string,
): string => {
	const paddingTop = content.paddingTop ?? 16;
	const paddingRight = content.paddingRight ?? 24;
	const paddingBottom = content.paddingBottom ?? 16;
	const paddingLeft = content.paddingLeft ?? 24;
	const marginTop = content.marginTop ?? 0;
	const marginBottom = content.marginBottom ?? 0;

	const borderWidth = content.borderWidth ?? 0;
	const borderStyle = content.borderStyle ?? 'none';
	const borderColor = content.borderColor ?? '#000000';
	const borderRadius = content.borderRadius ?? 0;
	const bgColor = content.backgroundColor || 'transparent';
	const maxWidthPercent = content.maxWidth ?? 100;

	const pixelWidth = toPixelWidth(maxWidthPercent, baseWidth);

	const childHtml = content.items
		.map((item) => walk(itemToBlock(item), pixelWidth, 'container'))
		.filter(Boolean)
		.join('');

	const hasBorder = borderWidth > 0 && borderStyle !== 'none';
	const borderCss = hasBorder ? `border:${borderWidth}px ${borderStyle} ${escapeCss(borderColor)};` : '';
	const bgCss = bgColor !== 'transparent' ? `background-color:${escapeCss(bgColor)};` : '';
	const gradientCss = escapeCss(gradientToCssOrEmpty(content.backgroundGradient));
	const radiusCss = borderRadius > 0 ? `border-radius:${borderRadius}px;` : '';
	const padding = `padding:${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px`;

	const bgImage = content.backgroundImage;
	const bgPosition = content.backgroundPosition || 'center';
	const bgSize = content.backgroundSize || 'cover';
	const bgImageCss = bgImage
		? backgroundImageCss(escapeCssUrl(bgImage), bgPosition, bgSize)
		: '';

	const msoTdStyle = [bgCss, borderCss].filter(Boolean).join('');
	const marginStyle = marginTop > 0 || marginBottom > 0
		? `margin:${marginTop}px auto ${marginBottom}px auto;`
		: 'margin:0 auto;';

	const parts: string[] = [];

	if (bgImage) {
		parts.push(msoVmlBackground(bgImage, pixelWidth, paddingTop + paddingBottom + 200, bgColor !== 'transparent' ? bgColor : '#ffffff'));
	}
	if (!bgImage) {
		parts.push(`<!--[if mso]><table width="${pixelWidth}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="${msoTdStyle}"><![endif]-->`);
	}

	parts.push(`<!--[if !mso]><!--><div style="max-width:${maxWidthPercent}%;${marginStyle}"><!--<![endif]-->`);
	const innerTableStyle = [bgCss, gradientCss, bgImageCss, borderCss, radiusCss].filter(Boolean).join('');
	parts.push(`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${innerTableStyle ? ` style="${innerTableStyle}"` : ''}>`);
	parts.push(`<tr><td style="${padding}">${childHtml}</td></tr>`);
	parts.push('</table>');
	parts.push('<!--[if !mso]><!--></div><!--<![endif]-->');

	if (bgImage) {
		parts.push(msoVmlBackgroundClose());
	} else {
		parts.push('<!--[if mso]></td></tr></table><![endif]-->');
	}

	return parts.join('');
};

export const containerModule: BlockModule<'container'> = {
	type: 'container',
	placements: ['root', 'container'] as readonly Placement[],

	isEmpty(content) {
		return !content.items || content.items.length === 0;
	},

	html({ content, ctx, placement, walk }) {
		if (placement === 'root') {
			return renderRoot(content, ctx, walk as never);
		}
		return renderNested(content, ctx.baseWidth, walk as never);
	},

	plaintext({ content, walk }) {
		const parts: string[] = [];
		for (const item of content.items) {
			const text = walk(itemToBlock(item));
			if (text) parts.push(text);
		}
		return parts.join('\n');
	},

	amp({ content, walk }) {
		const style = content.backgroundColor ? `background-color:${escapeCss(content.backgroundColor)};` : '';
		const itemsHtml = content.items.map((item) =>
			walk(itemToBlock(item))
		).join('\n');
		return `<div style="${style}padding:${content.paddingTop}px ${content.paddingRight}px ${content.paddingBottom}px ${content.paddingLeft}px">${itemsHtml}</div>`;
	},

	createDefault() {
		return {
			items: [],
			maxWidth: 100,
			paddingTop: 16,
			paddingRight: 24,
			paddingBottom: 16,
			paddingLeft: 24,
			paddingLinked: false,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
			borderWidth: 0,
			borderColor: '#e5e5e5',
			borderStyle: 'solid',
			borderRadius: 8,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Dark mode overrides',
				description:
					'Per-block dark background/text color via CSS custom properties and prefers-color-scheme',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
					protonMail: 'none',
				},
				fallback:
					'Light mode colors used. Outlook Desktop does not support dark mode.',
				owlatHandled: true,
				canIEmailSlug: 'css-at-media-prefers-color-scheme',
			},
			{
				feature: 'border-radius',
				description: 'Rounded corners on container',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				fallback: 'Square corners in Outlook',
				owlatHandled: false,
				canIEmailSlug: 'css-border-radius',
			},
			{
				feature: 'Background image',
				description: 'Background image on container',
				support: fullSupport,
				fallback: 'Owlat uses VML v:rect with v:fill for Outlook background images',
				owlatHandled: true,
				canIEmailSlug: 'css-background-image',
			},
			{
				feature: 'Nested containers',
				description: 'Containers within containers',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		const ic = content as unknown as Record<string, unknown>;

		// Shape
		checkShape(ic, [
			{ field: 'items', check: isArray, code: 'CONTAINER_ITEMS_TYPE', message: 'items must be an array' },
			{ field: 'maxWidth', check: isNumber, code: 'CONTAINER_MAX_WIDTH_TYPE', message: 'maxWidth must be a number' },
			{ field: 'paddingTop', check: isNumber, code: 'CONTAINER_PADDING_TOP_TYPE', message: 'paddingTop must be a number' },
			{ field: 'paddingRight', check: isNumber, code: 'CONTAINER_PADDING_RIGHT_TYPE', message: 'paddingRight must be a number' },
			{ field: 'paddingBottom', check: isNumber, code: 'CONTAINER_PADDING_BOTTOM_TYPE', message: 'paddingBottom must be a number' },
			{ field: 'paddingLeft', check: isNumber, code: 'CONTAINER_PADDING_LEFT_TYPE', message: 'paddingLeft must be a number' },
			{ field: 'borderWidth', check: isNumber, code: 'CONTAINER_BORDER_WIDTH_TYPE', message: 'borderWidth must be a number' },
			{ field: 'borderColor', check: isString, code: 'CONTAINER_BORDER_COLOR_TYPE', message: 'borderColor must be a string' },
			{ field: 'borderStyle', check: (v) => isOneOf(v, BORDER_STYLES), code: 'CONTAINER_BORDER_STYLE_INVALID', message: 'borderStyle must be solid, dashed, dotted, or none' },
			{ field: 'borderRadius', check: isNumber, code: 'CONTAINER_BORDER_RADIUS_TYPE', message: 'borderRadius must be a number' },
		], block.id, 'container', ctx.issues);

		if (isArray(ic['items'])) {
			for (let i = 0; i < (ic['items'] as unknown[]).length; i++) {
				const item = (ic['items'] as unknown[])[i];
				if (!isObject(item) || !isString(item['id']) || !isString(item['type'])) {
					ctx.issues.push({ blockId: block.id, blockType: 'container', severity: 'error', code: 'CONTAINER_ITEM_SHAPE', message: `container item ${i} must have id and type strings` });
				}
			}
		}

		// Semantic
		if (ctx.depth > 3) {
			ctx.issues.push({ blockId: block.id, blockType: 'container', severity: 'warning', code: 'CONTAINER_DEEP_NESTING', message: `Container nesting depth (${ctx.depth}) exceeds recommended maximum of 3` });
		}

		// Outlook: nested border-radius warning, gradient multi-stop, maxWidth note
		if (content.borderRadius && content.borderRadius > 0) {
			for (const item of content.items) {
				const itemContent = item.content as { borderRadius?: unknown };
				if (typeof itemContent.borderRadius === 'number' && itemContent.borderRadius > 0) {
					ctx.issues.push({ blockId: item.id, blockType: item.type, severity: 'info', code: 'OUTLOOK_NESTED_BORDER_RADIUS', message: 'Nested border-radius inside a container with border-radius — Outlook ignores both. Visual degradation only.' });
				}
			}
		}
		if (content.maxWidth && !content.backgroundImage) {
			ctx.issues.push({ blockId: block.id, blockType: 'container', severity: 'info', code: 'OUTLOOK_MAX_WIDTH_ONLY', message: 'Container uses maxWidth — Outlook ignores max-width CSS but Owlat sets width attribute on the table, so this is handled.' });
		}
		checkGradientStopLimit(content.backgroundGradient, block.id, 'container', ctx.issues);

		// Recurse into items via the validator's ctx.recurse
		for (const item of content.items) {
			ctx.recurse(itemToBlock(item), ctx.depth + 1);
		}
	},
};
