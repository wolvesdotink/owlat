/**
 * Block module: button.
 *
 * VML "bulletproof" button for Outlook (v:roundrect with optional gradient fill)
 * sitting alongside the standard CSS/HTML button for every other client. The
 * %-width warning lives in `preflight` since VML in Outlook ignores percentage
 * widths regardless of placement.
 */

import { fullSupport, type ButtonBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { gradientToCss } from '../../helpers/gradient';
import { wrapColumnItem } from '../../helpers/table';
import { escapeAttr, escapeHtml, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, checkGradientStopLimit, isString, isNumber, isOneOf } from '../../helpers/validation';
import { getContrastRatio } from '../../validators/registry';

const ALIGNS_FULL = ['left', 'center', 'right', 'full'] as const;

/**
 * Generate the VML bulletproof button for Outlook (v:roundrect). Supports
 * fillcolor (solid) and v:fill (gradient).
 */
const renderVmlButton = (content: ButtonBlockContent): string => {
	const px = content.paddingX || 24;
	const py = content.paddingY || 12;
	const fontSize = content.fontSize ?? 16;
	const fontFamily = content.fontFamily ?? 'Arial, sans-serif';
	const fontWeight = content.fontWeight ?? 400;
	const radius = content.borderRadius;

	let btnWidth: number | undefined;
	if (content.align === 'full') {
		btnWidth = 600;
	} else if (content.buttonWidth && content.buttonWidth.endsWith('px')) {
		btnWidth = parseInt(content.buttonWidth, 10) || undefined;
	}

	const strokeWeight = content.buttonBorderWidth && content.buttonBorderWidth > 0 ? content.buttonBorderWidth : 0;
	const strokeColor = content.buttonBorderColor || content.backgroundColor;
	const strokeAttr = strokeWeight > 0
		? ` strokeweight="${strokeWeight}px" strokecolor="${strokeColor}"`
		: ' stroked="false"';

	const widthAttr = btnWidth ? ` style="width:${btnWidth}px"` : '';
	const textTransformStyle = content.textTransform && content.textTransform !== 'none' ? `text-transform:${content.textTransform};` : '';
	const letterSpacingStyle = content.letterSpacing ? `letter-spacing:${content.letterSpacing}px;` : '';

	const gradient = content.backgroundGradient;
	if (gradient && gradient.stops.length >= 2) {
		const color1 = gradient.stops[0]!.color;
		const color2 = gradient.stops[gradient.stops.length - 1]!.color;
		const fillHtml = `<v:fill type="gradient" color="${color1}" color2="${color2}" angle="180" />`;
		return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeAttr(sanitizeUrl(content.url))}"${widthAttr} arcsize="${Math.round((radius / 40) * 100)}%"${strokeAttr}>${fillHtml}<w:anchorlock/><center style="color:${content.textColor};font-family:${fontFamily};font-size:${fontSize}px;font-weight:${fontWeight};${textTransformStyle}${letterSpacingStyle}padding:${py}px ${px}px">${escapeHtml(content.text)}</center></v:roundrect><![endif]-->`;
	}

	return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeAttr(sanitizeUrl(content.url))}"${widthAttr} arcsize="${Math.round((radius / 40) * 100)}%" fillcolor="${content.backgroundColor}"${strokeAttr}><w:anchorlock/><center style="color:${content.textColor};font-family:${fontFamily};font-size:${fontSize}px;font-weight:${fontWeight};${textTransformStyle}${letterSpacingStyle}padding:${py}px ${px}px">${escapeHtml(content.text)}</center></v:roundrect><![endif]-->`;
};

/**
 * Render the button inner HTML (VML + non-MSO branch). Returned at root
 * placement directly; at column/container placement the Walker-style wrap is
 * added by the module's `html()` below.
 *
 * Exported because the XSS regression suite asserts on the inner output.
 */
export const renderButtonContent = (content: ButtonBlockContent): string => {
	const tableAlign = content.align === 'full' ? 'center' : content.align;
	let btnWidth = '';
	if (content.align === 'full') {
		btnWidth = 'width:100%;';
	} else if (content.buttonWidth) {
		btnWidth = `width:${content.buttonWidth};`;
	}
	const displayStyle = content.align === 'full' ? 'display:block;' : 'display:inline-block;';
	const fontSize = content.fontSize ?? 'inherit';
	const fontFamily = content.fontFamily ?? 'inherit';
	const fontWeight = content.fontWeight ?? 'inherit';

	const tdStyles: string[] = [
		`background-color:${content.backgroundColor}`,
		`border-radius:${content.borderRadius}px`,
		'text-align:center',
		`mso-padding-alt:${content.paddingY || 12}px ${content.paddingX || 24}px`,
	];

	if (content.backgroundGradient && content.backgroundGradient.stops.length >= 2) {
		tdStyles.push(`background:${gradientToCss(content.backgroundGradient)}`);
	}

	if (content.buttonBorderWidth && content.buttonBorderWidth > 0 && content.buttonBorderStyle !== 'none') {
		tdStyles.push(`border:${content.buttonBorderWidth}px ${content.buttonBorderStyle || 'solid'} ${content.buttonBorderColor || '#000000'}`);
	}

	const linkStyles: string[] = [
		displayStyle,
		btnWidth,
		`color:${content.textColor}`,
		`padding:${content.paddingY || 12}px ${content.paddingX || 24}px`,
		'text-decoration:none',
		`font-size:${typeof fontSize === 'number' ? `${fontSize}px` : fontSize}`,
		`font-family:${fontFamily}`,
		`font-weight:${fontWeight}`,
	];

	if (content.letterSpacing) linkStyles.push(`letter-spacing:${content.letterSpacing}px`);
	if (content.textTransform && content.textTransform !== 'none') linkStyles.push(`text-transform:${content.textTransform}`);

	const linkStyleStr = linkStyles.filter(Boolean).join(';');
	const target = content.target || '_blank';

	const vml = renderVmlButton(content);
	const notMsoStart = '<!--[if !mso]><!-->';
	const notMsoEnd = '<!--<![endif]-->';

	const tableWidth = content.align === 'full' ? ' width="100%"' : (content.buttonWidth ? ` width="${content.buttonWidth}"` : '');
	const safeUrl = escapeAttr(sanitizeUrl(content.url));
	const relAttr = target === '_blank' ? ' rel="noopener noreferrer"' : '';
	return `${vml}${notMsoStart}<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${tableAlign}"${tableWidth}><tr><td style="${tdStyles.join(';')}"><a href="${safeUrl}" target="${target}"${relAttr} style="${linkStyleStr}">${escapeHtml(content.text)}</a></td></tr></table>${notMsoEnd}`;
};

export const buttonModule: BlockModule<'button'> = {
	type: 'button',
	placements: ['root', 'column', 'container'] as readonly Placement[],

	preflight({ block, ctx }) {
		if (block.content.buttonWidth && block.content.buttonWidth.endsWith('%')) {
			ctx.warnings.push(
				`Button block "${block.id}" uses percentage buttonWidth (${block.content.buttonWidth}) — VML in Outlook ignores percentage widths.`,
			);
		}
	},

	layout(content) {
		// `content.backgroundColor` is the button's fill, not the section's. The
		// section background comes from a separate `blockBackgroundColor` field
		// so users can frame the button with a contrasting band.
		const bg = content.blockBackgroundColor;
		return bg && bg !== 'transparent' ? { background: bg } : {};
	},

	applyTheme(content, theme) {
		if (!theme.buttonDefaults) return content;
		const d = theme.buttonDefaults;
		return {
			...content,
			backgroundColor: content.backgroundColor || d.backgroundColor || content.backgroundColor,
			textColor: content.textColor || d.textColor || content.textColor,
			borderRadius: content.borderRadius ?? d.borderRadius ?? content.borderRadius,
			fontSize: content.fontSize ?? d.fontSize,
			fontFamily: content.fontFamily ?? d.fontFamily,
			fontWeight: content.fontWeight ?? d.fontWeight,
			paddingX: content.paddingX ?? d.paddingX ?? content.paddingX,
			paddingY: content.paddingY ?? d.paddingY ?? content.paddingY,
		};
	},

	html({ block, content, ctx, placement }) {
		const transformed = ctx.linkTransform
			? { ...content, url: transformUrl(content.url, 'button', block.id, ctx) }
			: content;
		const inner = renderButtonContent(transformed);
		return placement === 'root' ? inner : wrapColumnItem(inner);
	},

	plaintext({ content }) {
		return `[${content.text}] ${content.url}`;
	},

	amp({ content }) {
		const href = sanitizeUrl(content.url);
		return `<div style="text-align:${content.align === 'full' ? 'center' : content.align}"><a href="${escapeAttr(href)}" class="owlat-btn" style="background-color:${escapeAttr(content.backgroundColor)};color:${escapeAttr(content.textColor)};border-radius:${content.borderRadius}px;font-size:${content.fontSize ?? 16}px">${escapeHtml(content.text)}</a></div>`;
	},

	createDefault(theme) {
		return {
			text: 'Click here',
			url: 'https://',
			backgroundColor: theme.primaryColor ?? '#000000',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 8,
			paddingX: 24,
			paddingY: 12,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'border-radius',
				description: 'Rounded corners on buttons',
				support: fullSupport,
				fallback: 'Owlat uses VML v:roundrect for pixel-perfect rounded buttons in Outlook',
				owlatHandled: true,
				canIEmailSlug: 'css-border-radius',
			},
			{
				feature: 'Background color',
				description: 'Button background color',
				support: fullSupport,
				fallback: 'Owlat uses VML fillcolor for bulletproof button backgrounds in Outlook',
				owlatHandled: true,
				canIEmailSlug: 'css-background-color',
			},
			{
				feature: 'Button border',
				description: 'Border on button element',
				support: fullSupport,
				fallback: 'Owlat uses VML strokeweight for button borders in Outlook',
				owlatHandled: true,
				canIEmailSlug: 'css-border',
			},
			{
				feature: 'Full-width mode',
				description: 'Button stretches to full container width',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'VML uses fixed width estimate in Outlook',
				owlatHandled: false,
			},
			{
				feature: 'Explicit button width',
				description: 'Custom width on buttons (px or %)',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback:
					'VML supports pixel widths only. Percentage widths ignored in Outlook.',
				owlatHandled: true,
			},
			{
				feature: 'letter-spacing',
				description: 'Letter spacing on button text',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'May be ignored in VML rendering',
				owlatHandled: false,
				canIEmailSlug: 'css-letter-spacing',
			},
			{
				feature: 'Gradient background',
				description: 'Gradient background on button',
				support: {
					...fullSupport,
					gmail: 'partial',
					outlookDesktop: 'none',
					outlook365: 'none',
				},
				fallback: 'Use solid color fallback',
				owlatHandled: false,
				canIEmailSlug: 'css-linear-gradient',
			},
		],
		properties: [
			{
				property: 'borderRadius',
				description: 'Rounded corners on buttons',
				support: fullSupport,
				severity: 'info',
				recommendation:
					'Owlat uses VML v:roundrect — works in all clients including Outlook',
				owlatHandled: true,
			},
			{
				property: 'buttonWidth',
				description: 'Explicit button width (px or %)',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				severity: 'warning',
				recommendation:
					'Use pixel widths for Outlook compatibility. Percentage widths are ignored in VML.',
				owlatHandled: true,
			},
			{
				property: 'letterSpacing',
				description: 'Letter spacing on button text',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				severity: 'info',
				recommendation: 'May be ignored in VML button rendering',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'text', check: isString, code: 'BUTTON_TEXT_TYPE', message: 'text must be a string' },
			{ field: 'url', check: isString, code: 'BUTTON_URL_TYPE', message: 'url must be a string' },
			{ field: 'backgroundColor', check: isString, code: 'BUTTON_BG_TYPE', message: 'backgroundColor must be a string' },
			{ field: 'textColor', check: isString, code: 'BUTTON_TEXTCOLOR_TYPE', message: 'textColor must be a string' },
			{ field: 'align', check: (v) => isOneOf(v, ALIGNS_FULL), code: 'BUTTON_ALIGN_INVALID', message: 'align must be left, center, right, or full' },
			{ field: 'borderRadius', check: isNumber, code: 'BUTTON_BORDER_RADIUS_TYPE', message: 'borderRadius must be a number' },
			{ field: 'paddingX', check: isNumber, code: 'BUTTON_PADDING_X_TYPE', message: 'paddingX must be a number' },
			{ field: 'paddingY', check: isNumber, code: 'BUTTON_PADDING_Y_TYPE', message: 'paddingY must be a number' },
		], block.id, 'button', ctx.issues);

		// Semantic
		if (!content.url || content.url.trim() === '' || content.url === '#') {
			ctx.issues.push({ blockId: block.id, blockType: 'button', severity: 'error', code: 'BUTTON_NO_URL', message: 'Button block has no valid URL' });
		}
		if (!content.text || content.text.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'button', severity: 'warning', code: 'BUTTON_NO_TEXT', message: 'Button block has no text' });
		}

		// Accessibility (audit mode)
		if (ctx.options?.accessibilityAudit && content.backgroundColor && content.textColor) {
			const contrast = getContrastRatio(content.backgroundColor, content.textColor);
			if (contrast < 4.5) {
				ctx.issues.push({ blockId: block.id, blockType: 'button', severity: 'warning', code: 'A11Y_LOW_CONTRAST', message: `Button text contrast ratio (${contrast.toFixed(1)}:1) is below WCAG AA minimum of 4.5:1` });
			}
		}

		// Outlook
		if (content.backgroundGradient) {
			ctx.issues.push({ blockId: block.id, blockType: 'button', severity: 'warning', code: 'OUTLOOK_GRADIENT_BUTTON', message: 'Button has a gradient background — Outlook VML v:roundrect uses solid backgroundColor as fallback.' });
			checkGradientStopLimit(content.backgroundGradient, block.id, 'button', ctx.issues);
		}
	},
};
