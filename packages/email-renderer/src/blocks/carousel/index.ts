/**
 * Block module: carousel.
 *
 * CSS-only carousel via hidden radio inputs + `:checked ~` selectors. Slides,
 * dots, and optional thumbnails all toggle via the same radio group. Outlook
 * sees only the first slide (radios are wrapped in non-MSO conditionals).
 */

import { fullSupport, type CarouselBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { escapeAttr, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, isString, isArray, isObject } from '../../helpers/validation';

export const renderCarouselContent = (content: CarouselBlockContent, ctx: { globalRules: string[]; theme: { primaryColor?: string } }): string => {
	const images = content.images;
	if (!images || images.length === 0) return '';

	const carouselId = `owlat-car-${Math.random().toString(36).slice(2, 8)}`;
	const iconColor = content.iconColor || ctx.theme.primaryColor || '#333333';
	const inactiveColor = content.iconInactiveColor || '#cccccc';
	const iconWidth = content.iconWidth || 12;
	const borderRadius = content.borderRadius ? `border-radius:${content.borderRadius}px;` : '';
	const thumbnailWidth = content.thumbnailWidth || 0;
	const slidesClass = `${carouselId}-slides`;
	const dotsClass = `${carouselId}-dots`;
	const thumbsClass = `${carouselId}-thumbs`;

	const hideAll = `.${slidesClass} div[class^="${carouselId}-slide"]{display:none!important;max-height:0!important;overflow:hidden!important}`;
	const showChecked = images.map((_, i) =>
		`#${carouselId}-${i}:checked ~ .${slidesClass} .${carouselId}-slide-${i}{display:block!important;max-height:none!important;overflow:visible!important}`
	).join('\n');
	const resetDots = `.${dotsClass} label{background-color:${inactiveColor}!important}`;
	const activeDots = images.map((_, i) =>
		`#${carouselId}-${i}:checked ~ .${dotsClass} label[for="${carouselId}-${i}"]{background-color:${iconColor}!important}`
	).join('\n');

	let thumbCss = '';
	if (thumbnailWidth > 0) {
		const resetThumbs = `.${thumbsClass} label{border-color:transparent!important}`;
		const activeThumbs = images.map((_, i) =>
			`#${carouselId}-${i}:checked ~ .${thumbsClass} label[for="${carouselId}-${i}"]{border-color:${iconColor}!important}`
		).join('\n');
		thumbCss = `\n${resetThumbs}\n${activeThumbs}`;
	}

	const carouselCss = [hideAll, showChecked, resetDots, activeDots, thumbCss].filter(Boolean).join('\n');
	ctx.globalRules.push(carouselCss);

	const radios = images.map((_, i) =>
		`<input type="radio" id="${carouselId}-${i}" name="${carouselId}" style="display:none!important;max-height:0;visibility:hidden;font-size:0;mso-hide:all"${i === 0 ? ' checked="checked"' : ''} />`
	).join('');
	const radiosWrapped = `<!--[if !mso]><!-->${radios}<!--<![endif]-->`;

	const slides = images.map((img, i) => {
		const linkOpen = img.linkUrl ? `<a href="${escapeAttr(sanitizeUrl(img.linkUrl))}" target="_blank">` : '';
		const linkClose = img.linkUrl ? '</a>' : '';
		const display = i === 0 ? 'display:block' : 'display:none;max-height:0;overflow:hidden';
		const safeSrc = escapeAttr(sanitizeUrl(img.src));
		const safeAlt = escapeAttr(img.alt || '');
		return `<div class="${carouselId}-slide-${i}" style="${display}">${linkOpen}<img src="${safeSrc}" alt="${safeAlt}" width="100%" style="display:block;width:100%;height:auto;${borderRadius}" border="0" />${linkClose}</div>`;
	}).join('');

	const dots = images.map((_, i) => {
		const bg = i === 0 ? iconColor : inactiveColor;
		return `<label for="${carouselId}-${i}" style="display:inline-block;width:${iconWidth}px;height:${iconWidth}px;border-radius:50%;background-color:${bg};margin:0 4px;cursor:pointer"></label>`;
	}).join('');
	const dotsWrapped = `<!--[if !mso]><!--><div class="${dotsClass}" style="text-align:center;padding-top:8px">${dots}</div><!--<![endif]-->`;

	let thumbHtml = '';
	if (thumbnailWidth > 0) {
		const thumbs = images.map((img, i) => {
			const thumbSrc = img.thumbnailSrc || img.src;
			const safeThumbSrc = escapeAttr(sanitizeUrl(thumbSrc));
			const borderColor = i === 0 ? iconColor : 'transparent';
			return `<label for="${carouselId}-${i}" style="display:inline-block;margin:0 2px;cursor:pointer;border:2px solid ${borderColor};${borderRadius}"><img src="${safeThumbSrc}" alt="" width="${thumbnailWidth}" style="display:block;width:${thumbnailWidth}px;height:auto;${borderRadius}" border="0" /></label>`;
		}).join('');
		thumbHtml = `<!--[if !mso]><!--><div class="${thumbsClass}" style="text-align:center;padding-top:8px">${thumbs}</div><!--<![endif]-->`;
	}

	return `${radiosWrapped}<div class="${slidesClass}">${slides}</div>${dotsWrapped}${thumbHtml}`;
};

export const carouselModule: BlockModule<'carousel'> = {
	type: 'carousel',
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return !content.images || content.images.length === 0;
	},

	preflight({ ctx }) {
		ctx.warnings.push('Carousel block uses CSS :checked selectors — only interactive in Apple Mail/iOS Mail (~40% of clients). Other clients show first image as fallback.');
	},

	html({ block, content, ctx }) {
		const transformed = ctx.linkTransform
			? { ...content, images: content.images.map((img) => ({
					...img,
					linkUrl: img.linkUrl ? transformUrl(img.linkUrl, 'carousel', block.id, ctx) : img.linkUrl,
				})) }
			: content;
		return renderCarouselContent(transformed, ctx);
	},

	plaintext({ content }) {
		return content.images
			.map((img, i) => {
				const alt = img.alt ? `[Image ${i + 1}: ${img.alt}]` : `[Image ${i + 1}]`;
				return img.linkUrl ? `${alt} (${img.linkUrl})` : alt;
			})
			.join('\n');
	},

	amp({ content }) {
		const slides = content.images.map((img) => {
			const src = sanitizeUrl(img.src);
			if (!src) return '';
			const alt = escapeAttr(img.alt || '');
			const tag = `<amp-img src="${escapeAttr(src)}" alt="${alt}" width="600" height="400" layout="responsive"></amp-img>`;
			if (img.linkUrl) {
				const href = sanitizeUrl(img.linkUrl);
				return href ? `<a href="${escapeAttr(href)}">${tag}</a>` : tag;
			}
			return tag;
		}).join('\n');
		return `<amp-carousel width="600" height="400" layout="responsive" type="slides">${slides}</amp-carousel>`;
	},

	createDefault(theme) {
		return {
			images: [],
			iconWidth: 12,
			iconColor: theme.primaryColor ?? '#000000',
			iconInactiveColor: '#cccccc',
			thumbnailWidth: 0,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'CSS-only sliding',
				description: 'Image carousel using radio button + :checked CSS pattern',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
					samsungMail: 'partial',
					protonMail: 'none',
				},
				fallback:
					'First image shown as static fallback; all images stacked in non-supporting clients',
				owlatHandled: true,
				canIEmailSlug: 'css-pseudo-class-checked',
			},
			{
				feature: 'Navigation dots',
				description: 'Clickable navigation indicators below carousel',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				fallback: 'Dots hidden in non-supporting clients',
				owlatHandled: true,
			},
			{
				feature: 'Thumbnail strip',
				description: 'Thumbnail images for navigation',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				fallback: 'Thumbnails hidden in non-supporting clients',
				owlatHandled: true,
			},
		],
		properties: [
			{
				property: 'thumbnailWidth',
				description: 'Thumbnail strip width for navigation',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				severity: 'info',
				recommendation:
					'Thumbnails hidden in non-supporting clients — first image shown as static fallback',
				owlatHandled: true,
				degradationImpact: 'functional',
			},
			{
				property: 'borderRadius',
				description: 'Rounded corners on carousel images',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'info',
				recommendation: 'Square corners in Outlook',
				owlatHandled: false,
				degradationImpact: 'visual',
			},
		],
	},

	validate({ block, content, ctx }) {
		const ic = content as unknown as Record<string, unknown>;

		// Shape
		checkShape(ic, [
			{ field: 'images', check: isArray, code: 'CAROUSEL_IMAGES_TYPE', message: 'images must be an array' },
		], block.id, 'carousel', ctx.issues);

		if (isArray(ic['images'])) {
			for (let i = 0; i < (ic['images'] as unknown[]).length; i++) {
				const img = (ic['images'] as unknown[])[i];
				if (!isObject(img) || !isString(img['src']) || !isString(img['alt'])) {
					ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'error', code: 'CAROUSEL_IMAGE_SHAPE', message: `image ${i} must have src and alt strings` });
				}
			}
		}

		// Semantic
		ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'info', code: 'GMAIL_FORM_ELEMENTS', message: 'Carousel uses :checked CSS pattern with radio buttons — Gmail strips form elements, showing first image as static fallback' });

		if (!content.images || content.images.length === 0) {
			ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'error', code: 'CAROUSEL_NO_IMAGES', message: 'Carousel block has no images' });
		} else if (content.images.length === 1) {
			ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'info', code: 'CAROUSEL_SINGLE_IMAGE', message: 'Carousel has only one image — consider using an image block instead' });
		}
		if (content.images && content.images.length > 8) {
			ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'warning', code: 'CAROUSEL_MANY_IMAGES', message: `Carousel has ${content.images.length} images — more than 8 increases email size significantly and may cause slow loading` });
		}
		for (const img of content.images || []) {
			if (!img.src || img.src.trim() === '') {
				ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'error', code: 'CAROUSEL_IMAGE_NO_SRC', message: 'Carousel image has no source URL' });
			}
			if (ctx.options?.accessibilityAudit && (!img.alt || img.alt.trim() === '')) {
				ctx.issues.push({ blockId: block.id, blockType: 'carousel', severity: 'warning', code: 'A11Y_CAROUSEL_IMAGE_NO_ALT', message: 'Carousel image is missing alt text' });
			}
		}
	},
};
