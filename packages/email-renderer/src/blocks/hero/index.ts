/**
 * Block module: hero.
 *
 * Background-image hero with overlaid content. Uses VML `v:rect` so Outlook
 * gets the background image too; non-Outlook clients use a CSS
 * `background-image` on the wrapper div. The hero stretches to either a
 * fixed `height` (locked) or a `min-height` (fluid).
 *
 * Children are dispatched at the `container` placement so primitives use the
 * same column-cell shell they do inside accordions and nested containers.
 */

import { fullSupport } from '@owlat/shared';
import { itemToBlock, type BlockModule, type Placement } from '../_module';
import { gradientToCssOrEmpty } from '../../helpers/gradient';
import { msoVmlBackground, msoVmlBackgroundClose } from '../../outlook';
import { escapeCssUrl, escapeAttr, escapeCss } from '../../sanitize';
import { backgroundImageCss } from '../../helpers/inline-styles';
import { checkShape, checkGradientStopLimit, isString, isNumber, isArray, isOneOf } from '../../helpers/validation';

const HERO_BG_POSITIONS = ['top', 'center', 'bottom'] as const;
const HERO_BG_SIZES = ['cover', 'contain'] as const;
const HERO_MODES = ['fixed-height', 'fluid-height'] as const;
const HERO_V_ALIGNS = ['top', 'middle', 'bottom'] as const;

export const heroModule: BlockModule<'hero'> = {
	type: 'hero',
	placements: ['root'] as readonly Placement[],

	layout() {
		// Hero paints its background image directly on the section's outer wrap
		// and emits its own inner padding inside `html()`. The Walker should
		// therefore only apply margin as outer spacing — never sum
		// padding+margin into the section's <td>, or the bg image would be
		// inset by the padding.
		return { sectionMode: 'outer-only' };
	},

	html({ content, ctx, walk }) {
		const bgPosition = content.backgroundPosition || 'center';
		const bgSize = content.backgroundSize || 'cover';
		const height = content.height || 400;
		const vAlign = content.verticalAlign || 'middle';
		const overlayColor = content.overlayColor;

		const paddingTop = content.paddingTop ?? 40;
		const paddingRight = content.paddingRight ?? 24;
		const paddingBottom = content.paddingBottom ?? 40;
		const paddingLeft = content.paddingLeft ?? 24;

		const childHtml = content.items
			.map((item) => walk(itemToBlock(item), ctx.baseWidth, 'container'))
			.filter(Boolean)
			.join('');

		const heightStyle = content.mode === 'fixed-height' ? `height:${height}px;` : `min-height:${height}px;`;
		const overlayStyle = overlayColor ? `background-color:${escapeCss(overlayColor)};` : '';
		const gradientCss = escapeCss(gradientToCssOrEmpty(content.backgroundGradient));

		const parts: string[] = [];
		parts.push(msoVmlBackground(content.backgroundImage, ctx.baseWidth, height, '#ffffff'));
		parts.push(`<!--[if !mso]><!-->`);
		const bgImageCss = content.backgroundImage
			? backgroundImageCss(escapeCssUrl(content.backgroundImage), bgPosition, bgSize)
			: '';
		const divStyle = [gradientCss, bgImageCss, heightStyle].filter(Boolean).join('');
		parts.push(`<div style="${divStyle}">`);
		parts.push(`<!--<![endif]-->`);
		parts.push(`<table width="100%" height="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"${overlayStyle ? ` style="${overlayStyle}height:100%"` : ' style="height:100%"'}>`);
		parts.push(`<tr><td valign="${vAlign}" style="padding:${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px;vertical-align:${vAlign}">`);
		parts.push(childHtml);
		parts.push(`</td></tr></table>`);
		parts.push(`<!--[if !mso]><!--></div><!--<![endif]-->`);
		parts.push(msoVmlBackgroundClose());
		return parts.join('');
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
		// AMP4Email forbids VML and is unreliable with CSS background-image, so
		// the hero degrades to a padded block carrying the overlay/background
		// color. Its child blocks still recurse via `walk` instead of being
		// dropped to an empty comment.
		const itemsHtml = content.items
			.map((item) => walk(itemToBlock(item)))
			.filter(Boolean)
			.join('\n');
		const bg = content.overlayColor || content.backgroundColor;
		const bgStyle = bg ? `background-color:${escapeAttr(bg)};` : '';
		const paddingTop = content.paddingTop ?? 40;
		const paddingRight = content.paddingRight ?? 24;
		const paddingBottom = content.paddingBottom ?? 40;
		const paddingLeft = content.paddingLeft ?? 24;
		return `<div style="${bgStyle}padding:${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px">${itemsHtml}</div>`;
	},

	createDefault() {
		return {
			backgroundImage: '',
			backgroundPosition: 'center',
			backgroundSize: 'cover',
			height: 400,
			mode: 'fixed-height',
			verticalAlign: 'middle',
			items: [],
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Background image',
				description: 'Full-width background image',
				support: fullSupport,
				fallback: 'Owlat uses VML v:rect background for Outlook hero sections',
				owlatHandled: true,
				canIEmailSlug: 'css-background-image',
			},
			{
				feature: 'background-size: cover',
				description: 'Background image covers full area',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'VML type="frame" approximates cover behavior',
				owlatHandled: false,
				canIEmailSlug: 'css-background-size',
			},
			{
				feature: 'background-position',
				description: 'Background image positioning',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'VML centers by default',
				owlatHandled: false,
				canIEmailSlug: 'css-background-position',
			},
			{
				feature: 'Overlay color',
				description: 'Semi-transparent overlay on background',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'Outlook shows solid color overlay',
				owlatHandled: false,
			},
			{
				feature: 'Fluid height mode',
				description: 'Hero height adjusts to content',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'Fixed height is more reliable in Outlook',
				owlatHandled: false,
			},
		],
		properties: [
			{
				property: 'backgroundImage',
				description: 'Full-width background image',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Owlat provides VML fallback for Outlook — safe to use',
				owlatHandled: true,
			},
			{
				property: 'backgroundSize',
				description: 'Background image sizing (cover/contain)',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				severity: 'info',
				recommendation:
					'VML approximates cover behavior. Center your subject in the image for best results.',
				owlatHandled: false,
			},
			{
				property: 'backgroundPosition',
				description: 'Background image positioning',
				support: { ...fullSupport, outlookDesktop: 'none' },
				severity: 'info',
				recommendation: 'VML centers by default — design around centered positioning',
				owlatHandled: false,
			},
			{
				property: 'overlayColor',
				description: 'Semi-transparent overlay on background',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				severity: 'info',
				recommendation:
					'Outlook shows solid overlay. Ensure text is readable on both transparent and solid overlay.',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'backgroundImage', check: isString, code: 'HERO_BG_IMAGE_TYPE', message: 'backgroundImage must be a string' },
			{ field: 'backgroundPosition', check: (v) => isOneOf(v, HERO_BG_POSITIONS), code: 'HERO_BG_POSITION_INVALID', message: 'backgroundPosition must be top, center, or bottom' },
			{ field: 'backgroundSize', check: (v) => isOneOf(v, HERO_BG_SIZES), code: 'HERO_BG_SIZE_INVALID', message: 'backgroundSize must be cover or contain' },
			{ field: 'height', check: isNumber, code: 'HERO_HEIGHT_TYPE', message: 'height must be a number' },
			{ field: 'mode', check: (v) => isOneOf(v, HERO_MODES), code: 'HERO_MODE_INVALID', message: 'mode must be fixed-height or fluid-height' },
			{ field: 'verticalAlign', check: (v) => isOneOf(v, HERO_V_ALIGNS), code: 'HERO_VALIGN_INVALID', message: 'verticalAlign must be top, middle, or bottom' },
			{ field: 'items', check: isArray, code: 'HERO_ITEMS_TYPE', message: 'items must be an array' },
		], block.id, 'hero', ctx.issues);

		// Semantic
		if (!content.backgroundImage || content.backgroundImage.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'hero', severity: 'warning', code: 'HERO_NO_BG', message: 'Hero block has no background image' });
		}

		// Outlook
		if (content.mode === 'fluid-height') {
			ctx.issues.push({ blockId: block.id, blockType: 'hero', severity: 'warning', code: 'OUTLOOK_HERO_FLUID', message: 'Hero fluid-height mode is unreliable in Outlook — VML uses a fixed height. Consider using fixed-height for consistent rendering.' });
		}
		checkGradientStopLimit(content.backgroundGradient, block.id, 'hero', ctx.issues);

		// Recurse into items
		for (const item of content.items) {
			ctx.recurse(itemToBlock(item), ctx.depth + 1);
		}
	},
};
