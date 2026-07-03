import type { RenderContext, GmailAnnotations } from './types';
import { buildStyleBlock } from './styles';
import { getOfficeDocumentSettings, msoTableOpen, msoTableClose } from './outlook';
import { escapeAttr, escapeHtml, isHttpsUrl } from './sanitize';

/**
 * Generate hidden preheader text that shows as inbox preview snippet.
 * Padded with zero-width spaces to prevent email clients from pulling body content.
 */
const getPreheaderHtml = (text: string): string => {
	if (!text) return '';
	// Zero-width spaces + non-breaking spaces to fill preview and prevent body text leaking
	const padding = '&#847; &zwnj; &nbsp; &#8199; &#65279; '.repeat(30);
	return `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(text)}</div><div style="display:none;max-height:0;overflow:hidden" aria-hidden="true"><span style="font:0px/0 Arial">${padding}</span></div>`;
};

/**
 * Generate font import links for web fonts.
 */
const getFontImports = (fontUrls: string[]): string => {
	if (fontUrls.length === 0) return '';
	return fontUrls
		.filter((url) => isHttpsUrl(url))
		.map((url) => {
			// Append &display=swap to Google Fonts URLs for explicit font-display behavior
			let finalUrl = url;
			if (url.includes('fonts.googleapis.com') && !url.includes('display=')) {
				finalUrl += (url.includes('?') ? '&' : '?') + 'display=swap';
			}
			return `<link href="${escapeAttr(finalUrl)}" rel="stylesheet" type="text/css">`;
		})
		.join('');
};

/**
 * Dark mode meta tags for email clients that support them.
 * - color-scheme: tells clients this email supports both light and dark
 * - supported-color-schemes: Apple Mail / iOS specific
 */
const getDarkModeMeta = (): string => {
	return '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">';
};

/**
 * Generate Gmail Promotions tab JSON-LD annotations.
 * Enables rich cards in Gmail's Promotions tab with images, deals, promo codes.
 */
const getGmailAnnotations = (annotations: GmailAnnotations | undefined): string => {
	if (!annotations) return '';

	const jsonLd: Record<string, unknown> = {
		'@context': 'http://schema.org',
		'@type': 'PromotionCard',
	};

	if (annotations.description) {
		jsonLd['description'] = annotations.description;
	}

	if (annotations.image) {
		jsonLd['image'] = annotations.image;
	}

	if (annotations.logo) {
		jsonLd['logo'] = annotations.logo;
	}

	if (annotations.discountCode || annotations.dealDescription || annotations.availabilityEnds) {
		const offer: Record<string, unknown> = {
			'@type': 'Offer',
		};
		if (annotations.discountCode) {
			offer['discountCode'] = annotations.discountCode;
		}
		if (annotations.dealDescription) {
			offer['description'] = annotations.dealDescription;
		}
		if (annotations.availabilityEnds) {
			offer['availabilityEnds'] = annotations.availabilityEnds;
		}
		jsonLd['offers'] = offer;
	}

	// Serialize once with JSON.stringify (correct JSON escaping — no double
	// per-field escaping), then neutralize `<` so a user-controlled value can
	// never close the surrounding <script> element (`</script>` breakout XSS).
	// `<` is valid JSON and parses back to `<`, so consumers are unaffected.
	const serialized = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
	return `<script type="application/ld+json">${serialized}</script>`;
};

export const wrapDocument = (bodyContent: string, ctx: RenderContext): string => {
	const bgColor = ctx.darkMode ? (ctx.theme.darkModeBackgroundColor ?? '#121212') : ctx.theme.backgroundColor;
	const lang = ` lang="${escapeAttr(ctx.lang || 'en')}"`;
	const dir = ctx.direction !== 'ltr' ? ` dir="${escapeAttr(ctx.direction)}"` : '';
	const titleTag = ctx.title ? `<title>${escapeHtml(ctx.title)}</title>` : '<title></title>';
	const fontImports = getFontImports(ctx.fontUrls);
	const preheader = getPreheaderHtml(ctx.preheaderText);
	const darkModeMeta = getDarkModeMeta();
	const gmailJsonLd = getGmailAnnotations(ctx.gmailAnnotations);

	return `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"${lang}${dir}><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge">${darkModeMeta}${titleTag}${fontImports}${getOfficeDocumentSettings()}${buildStyleBlock(ctx)}${gmailJsonLd}</head><body style="margin:0;padding:0;background-color:${bgColor}">${preheader}<center><table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${bgColor}"><tr><td align="center">${msoTableOpen(ctx.baseWidth)}<div class="owlat-wrap" style="max-width:${ctx.baseWidth}px;margin:0 auto">${bodyContent}</div>${msoTableClose()}</td></tr></table></center></body></html>`;
};
