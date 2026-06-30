/**
 * Block module: image.
 *
 * Renders an `<img>` with optional link wrapping and dark-mode swap
 * (prefers-color-scheme via two stacked images). At column/container
 * placement the image is wrapped in a padding cell + an alignment table so it
 * sits correctly inside the column flow.
 */

import { fullSupport, type ImageBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { toPixelWidth } from '../../helpers/dimensions';
import { escapeAttr, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, isString, isNumber, isOneOf } from '../../helpers/validation';

const ALIGNS = ['left', 'center', 'right'] as const;

/** Build the bare `<img>` element + optional `<a>` wrap, no surrounding table. */
const renderImgElement = (content: ImageBlockContent, baseWidth: number): string => {
	if (!content.src) return '';

	const widthPx = toPixelWidth(content.width, baseWidth);
	const imgStyles: string[] = ['display:block', `width:${widthPx}px`, 'max-width:100%', 'border:0', 'outline:none'];
	if (content.height) imgStyles.push(`height:${content.height}px`);
	else imgStyles.push('height:auto');
	if (content.borderRadius) imgStyles.push(`border-radius:${content.borderRadius}px`);

	const fluidClass = content.fluidOnMobile ? ' class="owlat-fluid-img"' : '';
	const titleAttr = content.title ? ` title="${escapeAttr(content.title)}"` : '';
	const srcsetAttr = content.srcset ? ` srcset="${escapeAttr(content.srcset)}"` : '';
	const sizesAttr = content.sizes ? ` sizes="${escapeAttr(content.sizes)}"` : '';
	const safeSrc = escapeAttr(sanitizeUrl(content.src));
	const safeAlt = escapeAttr(content.alt || '');

	let imageHtml: string;
	if (content.darkSrc) {
		const safeDarkSrc = escapeAttr(sanitizeUrl(content.darkSrc));
		const lightClasses = [content.fluidOnMobile ? 'owlat-fluid-img' : '', 'owlat-light-img'].filter(Boolean).join(' ');
		const darkClasses = [content.fluidOnMobile ? 'owlat-fluid-img' : '', 'owlat-dark-img'].filter(Boolean).join(' ');
		const lightImg = `<img src="${safeSrc}" alt="${safeAlt}"${titleAttr} width="${widthPx}" border="0" class="${lightClasses}"${srcsetAttr}${sizesAttr} style="${imgStyles.join(';')}" />`;
		const darkImg = `<img src="${safeDarkSrc}" alt="${safeAlt}"${titleAttr} width="${widthPx}" border="0" class="${darkClasses}"${srcsetAttr}${sizesAttr} style="${[...imgStyles, 'display:none'].join(';')}" />`;
		imageHtml = lightImg + darkImg;
	} else {
		imageHtml = `<img src="${safeSrc}" alt="${safeAlt}"${titleAttr} width="${widthPx}" border="0"${fluidClass}${srcsetAttr}${sizesAttr} style="${imgStyles.join(';')}" />`;
	}

	const linkAriaLabel = content.alt ? ` aria-label="${safeAlt}"` : '';
	if (content.linkUrl) {
		return `<a href="${escapeAttr(sanitizeUrl(content.linkUrl))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;border:0;display:block"${linkAriaLabel}>${imageHtml}</a>`;
	}
	return imageHtml;
};

/** Root placement: alignment table wraps the image. */
const renderRoot = (content: ImageBlockContent, baseWidth: number): string => {
	if (!content.src) return '';
	const tableAlign = (['center', 'right', 'left'] as const).includes(content.align as never) ? content.align : 'center';
	return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${tableAlign}"><tr><td>${renderImgElement(content, baseWidth)}</td></tr></table>`;
};

/** Column/container placement: padding cell + alignment table. */
const renderInColumn = (content: ImageBlockContent, baseWidth: number): string => {
	if (!content.src) return '';
	const tableAlign = (['center', 'right', 'left'] as const).includes(content.align as never) ? content.align : 'center';
	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:8px 0"><table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${tableAlign}"><tr><td>${renderImgElement(content, baseWidth)}</td></tr></table></td></tr></table>`;
};

export const imageModule: BlockModule<'image'> = {
	type: 'image',
	placements: ['root', 'column', 'container'] as readonly Placement[],

	isEmpty(content) {
		return !content.src;
	},

	html({ block, content, ctx, placement, width }) {
		const transformed = ctx.linkTransform && content.linkUrl
			? { ...content, linkUrl: transformUrl(content.linkUrl, 'image', block.id, ctx) }
			: content;
		// At root, the renderer's existing wrapSection uses ctx.baseWidth.
		// At column, the parent passes the column's allotted width via `width`.
		const widthForRender = placement === 'root' ? ctx.baseWidth : width;
		return placement === 'root'
			? renderRoot(transformed, widthForRender)
			: renderInColumn(transformed, widthForRender);
	},

	plaintext({ content }) {
		const alt = content.alt ? `[Image: ${content.alt}]` : '[Image]';
		return content.linkUrl ? `${alt} (${content.linkUrl})` : alt;
	},

	amp({ content }) {
		if (!content.src) return '';
		const src = sanitizeUrl(content.src);
		if (!src) return '';
		const width = content.width || 600;
		const height = content.height || Math.round(width * 0.6);
		const alt = escapeAttr(content.alt || '');
		const imgTag = `<amp-img src="${escapeAttr(src)}" alt="${alt}" width="${width}" height="${height}" layout="responsive"></amp-img>`;
		if (content.linkUrl) {
			const href = sanitizeUrl(content.linkUrl);
			return href ? `<a href="${escapeAttr(href)}">${imgTag}</a>` : imgTag;
		}
		return imgTag;
	},

	createDefault() {
		return {
			src: '',
			alt: '',
			width: 100,
			align: 'center',
			storageId: undefined,
			linkUrl: undefined,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'border-radius',
				description: 'Rounded corners on images',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				fallback: 'Square corners in Outlook desktop',
				owlatHandled: false,
				canIEmailSlug: 'css-border-radius',
			},
			{
				feature: 'Fluid on mobile',
				description: 'Image scales to 100% width on small screens',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'Outlook keeps fixed width',
				owlatHandled: false,
			},
			{
				feature: 'Animated GIF',
				description: 'Animated GIF playback',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'Outlook shows first frame only',
				owlatHandled: false,
			},
			{
				feature: 'srcset',
				description: 'Responsive image srcset for retina displays',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					outlookMac: 'none',
					yahooMail: 'none',
					samsungMail: 'none',
				},
				fallback: 'Falls back to base src attribute in unsupported clients',
				owlatHandled: false,
				canIEmailSlug: 'html-srcset',
			},
			{
				feature: 'SVG images',
				description: 'SVG image format support',
				support: {
					...fullSupport,
					gmail: 'partial',
					outlookDesktop: 'none',
					outlook365: 'none',
					samsungMail: 'partial',
				},
				fallback: 'Use PNG/JPG fallback instead',
				owlatHandled: false,
				canIEmailSlug: 'html-svg',
			},
			{
				feature: 'Dark mode image swap',
				description: 'Alternative image source shown in dark mode via prefers-color-scheme CSS',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
					protonMail: 'none',
				},
				fallback: 'Light mode image shown in all modes',
				owlatHandled: true,
				canIEmailSlug: 'css-at-media-prefers-color-scheme',
			},
			{
				feature: 'max-width CSS',
				description: 'CSS max-width property for image sizing',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'Outlook needs explicit width attribute on img tag — Owlat sets this automatically',
				owlatHandled: true,
				canIEmailSlug: 'css-max-width',
			},
		],
		properties: [
			{
				property: 'borderRadius',
				description: 'Rounded corners on images',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'warning',
				recommendation: 'Use a PNG with baked-in corners if Outlook rendering is critical',
				owlatHandled: false,
				degradationImpact: 'visual',
				fixes: [
					{
						action: 'remove-property',
						property: 'borderRadius',
						description: 'Remove border-radius for consistent square corners everywhere',
					},
				],
			},
			{
				property: 'fluidOnMobile',
				description: 'Image scales to full width on mobile',
				support: { ...fullSupport, outlookDesktop: 'none' },
				severity: 'info',
				recommendation: 'Outlook keeps fixed width — acceptable for desktop client',
				owlatHandled: true,
			},
			{
				property: 'srcset',
				description: 'Responsive image srcset for retina/HiDPI',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					outlookMac: 'none',
					yahooMail: 'none',
					samsungMail: 'none',
				},
				severity: 'info',
				recommendation: 'Always provide a base src attribute as fallback',
				owlatHandled: true,
			},
			{
				property: 'darkSrc',
				description: 'Alternative image for dark mode',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
					protonMail: 'none',
				},
				severity: 'info',
				recommendation:
					'Light image shown in ~60% of clients. Design light image to work in both modes if possible.',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'src', check: isString, code: 'IMAGE_SRC_TYPE', message: 'src must be a string' },
			{ field: 'alt', check: isString, code: 'IMAGE_ALT_TYPE', message: 'alt must be a string' },
			{ field: 'width', check: isNumber, code: 'IMAGE_WIDTH_TYPE', message: 'width must be a number' },
			{ field: 'align', check: (v) => isOneOf(v, ALIGNS), code: 'IMAGE_ALIGN_INVALID', message: 'align must be left, center, or right' },
		], block.id, 'image', ctx.issues);

		// Semantic
		if (!content.src || content.src.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'image', severity: 'error', code: 'IMAGE_NO_SRC', message: 'Image block has no source URL' });
		}
		if (!content.alt || content.alt.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'image', severity: 'warning', code: 'IMAGE_NO_ALT', message: 'Image block is missing alt text (accessibility)' });
		}
		if (content.src?.startsWith('data:')) {
			ctx.issues.push({ blockId: block.id, blockType: 'image', severity: 'warning', code: 'IMAGE_DATA_URI', message: 'Image uses a data URI — this increases email size significantly and some clients block data URIs. Use a hosted URL instead.' });
		}

		// Outlook
		if (!content.width || content.width <= 0) {
			ctx.issues.push({ blockId: block.id, blockType: 'image', severity: 'warning', code: 'OUTLOOK_IMAGE_NO_WIDTH', message: 'Image has no explicit width — Outlook may render at full size or 0px. Always set a width.' });
		}
	},
};
