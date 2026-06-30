/**
 * Block module: menu.
 *
 * Horizontal nav links rendered as a single-row table for client
 * compatibility. When `hamburgerOnMobile` is set, also emits a CSS-only
 * `:checked`-toggle hamburger that works in Apple Mail / iOS Mail (the
 * `preflight` warning notes the fallback in other clients).
 *
 * Root placement only — the historical `renderColumnItem` switch did not
 * accept menu blocks.
 */

import { fullSupport, type MenuBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import type { RenderContext } from '../../types';
import { escapeHtml, escapeAttr, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, isString, isArray, isObject, isOneOf } from '../../helpers/validation';

const MENU_ALIGNS = ['left', 'center', 'right'] as const;

/**
 * The inner menu HTML. Exported because the legacy unit suite asserts on its
 * output directly.
 */
export const renderMenuContent = (content: MenuBlockContent, ctx: RenderContext): string => {
	if (!content.items || content.items.length === 0) return '';

	const fontSize = content.fontSize || 14;
	const fontFamily = content.fontFamily || ctx.theme.fontFamily;
	const fontWeight = content.fontWeight || 400;
	const textColor = content.textColor || ctx.theme.bodyTextColor || '#333333';
	const textTransform = content.textTransform && content.textTransform !== 'none'
		? `text-transform:${content.textTransform};`
		: '';
	const separator = content.separator || '';
	const separatorColor = content.separatorColor || '#999999';
	const itemSpacing = content.itemSpacing ?? 16;
	const halfSpacing = Math.floor(itemSpacing / 2);

	const linkStyle = `color:${textColor};text-decoration:none;font-size:${fontSize}px;font-family:${fontFamily};font-weight:${fontWeight};${textTransform}`;

	const cells = content.items.map((item, idx) => {
		const parts: string[] = [];
		if (idx > 0 && separator) {
			parts.push(`<td style="padding:0 ${halfSpacing}px;color:${separatorColor};font-size:${fontSize}px;font-family:${fontFamily}">${escapeHtml(separator)}</td>`);
		}
		const paddingStyle = `padding:0 ${halfSpacing}px`;
		const safeUrl = escapeAttr(sanitizeUrl(item.url));
		parts.push(`<td style="${paddingStyle}"><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">${escapeHtml(item.label)}</a></td>`);
		return parts.join('');
	}).join('');

	const desktopMenu = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${content.align}"><tr>${cells}</tr></table>`;

	if (!content.hamburgerOnMobile) {
		return desktopMenu;
	}

	const mobileLinks = content.items
		.map((item) => {
			const safeUrl = escapeAttr(sanitizeUrl(item.url));
			return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:block;padding:10px 16px;${linkStyle};border-bottom:1px solid #eee">${escapeHtml(item.label)}</a>`;
		})
		.join('');

	const hamburgerIcon = `<span style="font-size:24px;line-height:1;cursor:pointer;color:${textColor}">&#9776;</span>`;

	const style = `<style>` +
		`.owlat-menu-toggle{display:none!important;mso-hide:all}` +
		`.owlat-hamburger{display:none}` +
		`.owlat-mobile-nav{display:none;max-height:0;overflow:hidden}` +
		`@media only screen and (max-width:${ctx.breakpoint}px){` +
		`.owlat-desktop-nav{display:none!important}` +
		`.owlat-hamburger{display:block!important}` +
		`.owlat-mobile-nav{display:block!important;max-height:none!important;overflow:visible!important}` +
		`.owlat-menu-toggle:checked~.owlat-mobile-nav{display:block!important;max-height:none!important}` +
		`}` +
		`</style>`;

	return `${style}` +
		`<div class="owlat-desktop-nav">${desktopMenu}</div>` +
		`<input type="checkbox" id="owlat-menu-toggle" class="owlat-menu-toggle" />` +
		`<label for="owlat-menu-toggle" class="owlat-hamburger" style="text-align:${content.align}">${hamburgerIcon}</label>` +
		`<div class="owlat-mobile-nav">${mobileLinks}</div>`;
};

export const menuModule: BlockModule<'menu'> = {
	type: 'menu',
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return !content.items || content.items.length === 0;
	},

	preflight({ content, ctx }) {
		if (content.hamburgerOnMobile) {
			ctx.warnings.push('Menu with hamburgerOnMobile hides the menu on mobile with no interactive replacement. Consider disabling hamburgerOnMobile or see 3.3 hamburger menu feature.');
		}
	},

	html({ block, content, ctx }) {
		const transformed = ctx.linkTransform
			? { ...content, items: content.items.map((item) => ({
					...item,
					url: transformUrl(item.url, 'menu', block.id, ctx),
				})) }
			: content;
		return renderMenuContent(transformed, ctx);
	},

	plaintext({ content }) {
		return content.items.map((item) => `${item.label}: ${item.url}`).join(' | ');
	},

	amp({ content }) {
		// AMP4Email has no `:checked` hamburger toggle, so we render the static
		// horizontal nav row (a plain table of links — already AMP-valid) and
		// drop the mobile hamburger affordance.
		if (!content.items || content.items.length === 0) return '';

		const fontSize = content.fontSize || 14;
		const fontWeight = content.fontWeight || 400;
		const textColor = content.textColor || '#333333';
		const separator = content.separator || '';
		const separatorColor = content.separatorColor || '#999999';
		const itemSpacing = content.itemSpacing ?? 16;
		const halfSpacing = Math.floor(itemSpacing / 2);
		const linkStyle = `color:${escapeAttr(textColor)};text-decoration:none;font-size:${fontSize}px;font-weight:${fontWeight}`;

		const cells = content.items.map((item, idx) => {
			const parts: string[] = [];
			if (idx > 0 && separator) {
				parts.push(`<td style="padding:0 ${halfSpacing}px;color:${escapeAttr(separatorColor)};font-size:${fontSize}px">${escapeHtml(separator)}</td>`);
			}
			const safeUrl = escapeAttr(sanitizeUrl(item.url));
			parts.push(`<td style="padding:0 ${halfSpacing}px"><a href="${safeUrl}" style="${linkStyle}">${escapeHtml(item.label)}</a></td>`);
			return parts.join('');
		}).join('');

		return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${content.align}"><tr>${cells}</tr></table>`;
	},

	createDefault() {
		return {
			items: [
				{ label: 'Home', url: '#' },
				{ label: 'About', url: '#' },
				{ label: 'Contact', url: '#' },
			],
			align: 'center',
			fontSize: 14,
			textColor: '#374151',
			separator: '|',
			separatorColor: '#cccccc',
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Horizontal navigation',
				description: 'Horizontal menu links',
				support: fullSupport,
				fallback: 'Menu uses table-based horizontal layout with anchor links',
				owlatHandled: true,
				canIEmailSlug: 'html-anchor-links',
			},
			{
				feature: 'Hamburger on mobile',
				description:
					'CSS-only hamburger toggle with vertical mobile nav using :checked pattern',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'partial',
				},
				fallback:
					'Interactive toggle works in Apple Mail/iOS only. Other clients show expanded vertical nav on mobile (correct fallback). Outlook shows desktop horizontal menu.',
				owlatHandled: true,
				canIEmailSlug: 'css-pseudo-class-checked',
			},
			{
				feature: 'Separator character',
				description: 'Custom separator between menu items',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
			},
		],
		properties: [
			{
				property: 'hamburgerOnMobile',
				description: 'Hamburger toggle on mobile',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'partial',
				},
				severity: 'warning',
				recommendation:
					'Expanded vertical nav shown as fallback in non-supporting clients',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		const ic = content as unknown as Record<string, unknown>;

		// Shape
		checkShape(ic, [
			{ field: 'items', check: isArray, code: 'MENU_ITEMS_TYPE', message: 'items must be an array' },
			{ field: 'align', check: (v) => isOneOf(v, MENU_ALIGNS), code: 'MENU_ALIGN_INVALID', message: 'align must be left, center, or right' },
		], block.id, 'menu', ctx.issues);

		if (isArray(ic['items'])) {
			for (let i = 0; i < (ic['items'] as unknown[]).length; i++) {
				const item = (ic['items'] as unknown[])[i];
				if (!isObject(item) || !isString(item['label']) || !isString(item['url'])) {
					ctx.issues.push({ blockId: block.id, blockType: 'menu', severity: 'error', code: 'MENU_ITEM_SHAPE', message: `menu item ${i} must have label and url strings` });
				}
			}
		}

		// Semantic
		if (content.hamburgerOnMobile) {
			ctx.issues.push({ blockId: block.id, blockType: 'menu', severity: 'info', code: 'GMAIL_FORM_ELEMENTS', message: 'Menu hamburger toggle uses :checked CSS pattern — Gmail strips form elements, showing expanded vertical nav as fallback' });
		}
	},
};
