/**
 * Block module: text.
 *
 * Rich-text content (paragraph or heading) rendered as either a semantic
 * `<h1>`/`<h2>`/`<h3>` at root placement, or as fused inline styles on a
 * column-cell `<td>` at column/container placement. Link transforms apply to
 * every `<a href>` in the html field.
 */

import { fullSupport, type TextBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { transformHtmlLinks } from '../../helpers/linkTransform';
import { stripHtml, extractLinks } from '../../helpers/text';
import { escapeAttr, escapeCss, sanitizeRawHtml } from '../../sanitize';
import { checkShape, isString, isNumber, isOneOf } from '../../helpers/validation';

const TEXT_BLOCK_TYPES = ['paragraph', 'h1', 'h2', 'h3'] as const;
const VAGUE_LINK_PATTERNS = [
	'click here',
	'here',
	'read more',
	'link',
	'learn more',
	'more',
	'details',
	'find out',
	'find out more',
	'go',
	'continue',
	'see more',
	'view',
	'this',
	'more info',
];

/** Build the inline style list shared by both placements. */
const baseStyles = (
	content: TextBlockContent,
	includeMsoRule: boolean,
	alignAllValues: boolean
): string[] => {
	const lineHeight = content.lineHeight ?? 1.5;
	const styles: string[] = [
		`font-size:${content.fontSize}px`,
		`color:${escapeCss(content.textColor)}`,
		`line-height:${lineHeight}`,
	];
	if (includeMsoRule) styles.push('mso-line-height-rule:exactly');
	// At root placement, `text-align:left` is omitted (browser default).
	// At column placement, every textAlign is emitted (Outlook needs explicit alignment in column cells).
	if (
		alignAllValues ? !!content.textAlign : !!(content.textAlign && content.textAlign !== 'left')
	) {
		styles.push(`text-align:${content.textAlign}`);
	}
	if (content.fontFamily) styles.push(`font-family:${escapeCss(content.fontFamily)}`);
	if (content.fontWeight) styles.push(`font-weight:${content.fontWeight}`);
	if (content.letterSpacing) styles.push(`letter-spacing:${content.letterSpacing}px`);
	if (content.textTransform && content.textTransform !== 'none')
		styles.push(`text-transform:${content.textTransform}`);
	if (content.textDecoration && content.textDecoration !== 'none')
		styles.push(`text-decoration:${content.textDecoration}`);
	return styles;
};

const renderRoot = (content: TextBlockContent): string => {
	const styles = baseStyles(content, true, false);
	const tag =
		content.blockType === 'h1' || content.blockType === 'h2' || content.blockType === 'h3'
			? content.blockType
			: 'div';
	if (tag !== 'div') styles.push('margin:0', 'padding:0');
	return `<${tag} style="${styles.join(';')}">${content.html}</${tag}>`;
};

const renderInColumn = (content: TextBlockContent): string => {
	const styles = baseStyles(content, false, true);
	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:8px 0;${styles.join(';')}">${content.html}</td></tr></table>`;
};

export const textModule: BlockModule<'text'> = {
	type: 'text',
	placements: ['root', 'column', 'container'] as readonly Placement[],

	applyTheme(content, theme) {
		// Headings draw from `theme.headingDefaults[h1|h2|h3]` and
		// `theme.headingFontFamily`. Paragraphs draw from `theme.bodyFontSize`
		// and `theme.bodyTextColor`. Block-level fields always win — we never
		// overwrite an explicit value.
		const level = content.blockType;
		if (level !== 'paragraph' && theme.headingDefaults?.[level]) {
			const d = theme.headingDefaults[level]!;
			return {
				...content,
				fontSize: content.fontSize ?? d.fontSize ?? content.fontSize,
				fontWeight: content.fontWeight ?? d.fontWeight,
				textColor: content.textColor || d.textColor || content.textColor,
				lineHeight: content.lineHeight ?? d.lineHeight,
				letterSpacing: content.letterSpacing ?? d.letterSpacing,
				fontFamily: content.fontFamily || theme.headingFontFamily || content.fontFamily,
			};
		}
		if (level === 'paragraph') {
			return {
				...content,
				fontSize: content.fontSize ?? theme.bodyFontSize ?? content.fontSize,
				textColor: content.textColor || theme.bodyTextColor || content.textColor,
			};
		}
		return content;
	},

	responsiveCss({ block, content }) {
		if (!content.mobileFontSize) return [];
		return [`[data-block-id="${block.id}"] div{font-size:${content.mobileFontSize}px!important}`];
	},

	html({ block, content, ctx, placement }) {
		// Rich-text `html` is author-supplied (contenteditable output or direct
		// SDK/API writes) and is emitted verbatim into outbound email HTML and
		// the in-app non-sandboxed editor canvas. Run it through the same
		// allowlist sanitiser as the rawHtml block so event-handler attributes
		// (onerror=…) and <script>/<iframe> are stripped at the render boundary.
		const sanitized = { ...content, html: sanitizeRawHtml(content.html || '') };
		const transformed = ctx.linkTransform
			? { ...sanitized, html: transformHtmlLinks(sanitized.html, 'text', block.id, ctx) }
			: sanitized;
		return placement === 'root' ? renderRoot(transformed) : renderInColumn(transformed);
	},

	plaintext({ content }) {
		// Same missing-html guard as html(): blocks written via SDK/API may omit it.
		const withLinks = extractLinks(content.html || '');
		return stripHtml(withLinks);
	},

	amp({ content }) {
		const tag = content.blockType === 'paragraph' ? 'p' : content.blockType;
		const style = `font-size:${content.fontSize}px;color:${escapeAttr(content.textColor)};line-height:${content.lineHeight ?? 1.5}`;
		return `<${tag} style="${style}">${sanitizeRawHtml(content.html || '')}</${tag}>`;
	},

	createDefault() {
		return {
			html: 'Enter your text here...',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#374151',
			lineHeight: 1.5,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Web fonts',
				description: 'Custom web fonts loaded via @import or <link>',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'partial',
					samsungMail: 'partial',
					protonMail: 'none',
				},
				fallback: 'Falls back to font stack (Arial, sans-serif, etc.)',
				owlatHandled: false,
				canIEmailSlug: 'css-at-font-face',
			},
			{
				feature: 'letter-spacing',
				description: 'CSS letter-spacing property',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'May render slightly differently in Outlook',
				owlatHandled: false,
				canIEmailSlug: 'css-letter-spacing',
			},
			{
				feature: 'line-height',
				description: 'CSS line-height property',
				support: { ...fullSupport, outlookDesktop: 'buggy' },
				fallback: 'Outlook may add extra spacing',
				owlatHandled: false,
				canIEmailSlug: 'css-line-height',
			},
			{
				feature: 'text-align: justify',
				description: 'Justified text alignment',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
				canIEmailSlug: 'css-text-align',
			},
			{
				feature: 'mobileFontSize',
				description: 'Responsive font size on mobile via media query',
				support: {
					...fullSupport,
					gmail: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'partial',
				},
				fallback:
					'Owlat generates mobile media queries for responsive font sizing — Outlook Desktop ignores media queries (acceptable — desktop client).',
				owlatHandled: true,
				canIEmailSlug: 'css-at-media',
			},
		],
		properties: [
			{
				property: 'fontFamily',
				description: 'Web font family (non-system)',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					protonMail: 'none',
				},
				severity: 'warning',
				recommendation: 'Always include a fallback font stack (e.g., "Roboto, Arial, sans-serif")',
				owlatHandled: false,
			},
			{
				property: 'letterSpacing',
				description: 'CSS letter-spacing property',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				severity: 'info',
				recommendation: 'May render differently in Outlook — test critical headings',
				owlatHandled: false,
			},
			{
				property: 'lineHeight',
				description: 'CSS line-height property',
				support: { ...fullSupport, outlookDesktop: 'buggy' },
				severity: 'warning',
				recommendation:
					'Outlook may add extra spacing. Use unitless values (e.g., 1.5) for best results.',
				owlatHandled: false,
			},
			{
				property: 'textTransform',
				description: 'CSS text-transform property',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Safe to use everywhere',
				owlatHandled: false,
			},
			{
				property: 'textDecoration',
				description: 'CSS text-decoration property',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Safe to use everywhere',
				owlatHandled: false,
			},
			{
				property: 'mobileFontSize',
				description: 'Responsive font size on mobile via media query',
				support: {
					...fullSupport,
					gmail: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'partial',
				},
				severity: 'info',
				recommendation:
					'Desktop font size used in Gmail and Outlook. Works in Apple Mail, iOS, and most modern clients.',
				owlatHandled: true,
			},
			{
				property: 'borderRadius',
				description: 'Border radius on text block wrapper',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'info',
				recommendation: 'Square corners in Outlook — acceptable for most designs',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		ctx.state.hasTextBlock = true;

		// Shape
		checkShape(
			content as unknown as Record<string, unknown>,
			[
				{
					field: 'html',
					check: isString,
					code: 'TEXT_HTML_TYPE',
					message: 'html must be a string',
				},
				{
					field: 'blockType',
					check: (v) => isOneOf(v, TEXT_BLOCK_TYPES),
					code: 'TEXT_BLOCKTYPE_INVALID',
					message: 'blockType must be paragraph, h1, h2, or h3',
				},
				{
					field: 'fontSize',
					check: isNumber,
					code: 'TEXT_FONTSIZE_TYPE',
					message: 'fontSize must be a number',
				},
				{
					field: 'textColor',
					check: isString,
					code: 'TEXT_TEXTCOLOR_TYPE',
					message: 'textColor must be a string',
				},
			],
			block.id,
			'text',
			ctx.issues
		);

		// Semantic
		if (!content.html || content.html.trim() === '') {
			ctx.issues.push({
				blockId: block.id,
				blockType: 'text',
				severity: 'warning',
				code: 'TEXT_EMPTY',
				message: 'Text block has empty content',
			});
		}
		if (content.fontSize && content.fontSize < 13) {
			ctx.issues.push({
				blockId: block.id,
				blockType: 'text',
				severity: 'warning',
				code: 'TEXT_SMALL_FONT',
				message: `Font size ${content.fontSize}px is below 13px — some mobile clients enforce minimum font sizes, causing layout shifts`,
			});
		}

		// Accessibility (audit mode)
		if (ctx.options?.accessibilityAudit && content.blockType !== 'paragraph') {
			const level = parseInt(content.blockType.replace('h', ''), 10);
			ctx.state.headingLevels.push(level);
		}
		if (ctx.options?.accessibilityAudit && content.html) {
			const linkMatches = content.html.match(/<a[^>]*>([^<]*)<\/a>/gi);
			if (linkMatches) {
				for (const link of linkMatches) {
					const textMatch = link.match(/>([^<]*)</);
					const text = textMatch?.[1]?.trim().toLowerCase() || '';
					if (VAGUE_LINK_PATTERNS.includes(text)) {
						ctx.issues.push({
							blockId: block.id,
							blockType: 'text',
							severity: 'warning',
							code: 'A11Y_VAGUE_LINK_TEXT',
							message: `Link text "${text}" is vague — use descriptive link text for screen readers`,
						});
					}
				}
			}
		}

		// Outlook
		if (content.lineHeight && content.lineHeight > 3) {
			ctx.issues.push({
				blockId: block.id,
				blockType: 'text',
				severity: 'warning',
				code: 'OUTLOOK_LINE_HEIGHT_LARGE',
				message: `Line height ${content.lineHeight} is unusually large — Outlook may add excessive extra spacing. Use unitless values like 1.5.`,
			});
		}
		if (content.fontWeight && content.fontWeight !== 400 && content.fontWeight !== 700) {
			ctx.issues.push({
				blockId: block.id,
				blockType: 'text',
				severity: 'info',
				code: 'OUTLOOK_TEXT_FONT_WEIGHT',
				message: `Font weight ${content.fontWeight} is not supported in Outlook — only 400 (normal) and 700 (bold) are reliable`,
			});
		}
	},
};
