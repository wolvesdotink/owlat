/**
 * Block module: list.
 *
 * Bullet / numbered / check / icon list using table-based layout. We avoid
 * `<ul>`/`<ol>` because Outlook adds inconsistent spacing and Gmail strips
 * `list-style-type` on some list kinds.
 *
 * Each item becomes a `<tr>` with a bullet cell and a text cell.
 */

import { fullSupport, type ListBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { escapeHtml, escapeAttr, sanitizeUrl } from '../../sanitize';
import { checkShape, isArray, isOneOf } from '../../helpers/validation';

const LIST_TYPES = ['bullet', 'numbered', 'check', 'icon'] as const;

const getBulletContent = (
	listType: ListBlockContent['listType'],
	index: number,
	color: string,
	size: number,
	iconUrl?: string,
): string => {
	switch (listType) {
		case 'bullet':
			return '&#8226;';
		case 'numbered':
			return `${index + 1}.`;
		case 'check':
			return '&#10003;';
		case 'icon':
			if (iconUrl) {
				const safeIconUrl = escapeAttr(sanitizeUrl(iconUrl));
				return `<img src="${safeIconUrl}" alt="" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;border:0" border="0" />`;
			}
			return '&#8226;';
		default:
			return '&#8226;';
	}
};

const renderList = (content: ListBlockContent): string => {
	const items = content.items;
	if (!items || items.length === 0) return '';

	const fontSize = content.fontSize ?? 16;
	const textColor = content.textColor || '#333333';
	const bulletColor = content.bulletColor || textColor;
	const bulletSize = content.bulletSize ?? fontSize;
	const itemSpacing = content.itemSpacing ?? 6;

	const rows = items.map((item, i) => {
		const bulletContent = getBulletContent(content.listType, i, bulletColor, bulletSize, content.iconUrl);
		const paddingBottom = i < items.length - 1 ? itemSpacing : 0;
		return `<tr><td style="vertical-align:top;padding:0 8px ${paddingBottom}px 0;width:24px;font-size:${bulletSize}px;color:${bulletColor};line-height:1.5;font-family:inherit">${bulletContent}</td><td style="vertical-align:top;padding:0 0 ${paddingBottom}px 0;font-size:${fontSize}px;color:${textColor};line-height:1.5;font-family:inherit">${escapeHtml(item)}</td></tr>`;
	}).join('');

	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">${rows}</table>`;
};

export const listModule: BlockModule<'list'> = {
	type: 'list',
	// List is root-only — the historical renderColumnItem switch didn't accept it.
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return !content.items || content.items.length === 0;
	},

	html({ content }) {
		return renderList(content);
	},

	plaintext({ content }) {
		return content.items
			.map((item, i) => {
				const stripped = item.replace(/<[^>]+>/g, '').trim();
				switch (content.listType) {
					case 'numbered':
						return `${i + 1}. ${stripped}`;
					case 'check':
						return `[x] ${stripped}`;
					default:
						return `- ${stripped}`;
				}
			})
			.join('\n');
	},

	amp({ content }) {
		// AMP4Email forbids raw <img>, so the icon list renders an <amp-img>
		// bullet; bullet/numbered/check reuse the same table markup as the HTML
		// renderer, which is already AMP-valid.
		const items = content.items;
		if (!items || items.length === 0) return '';

		const fontSize = content.fontSize ?? 16;
		const textColor = content.textColor || '#333333';
		const bulletColor = content.bulletColor || textColor;
		const bulletSize = content.bulletSize ?? fontSize;
		const itemSpacing = content.itemSpacing ?? 6;

		const iconSrc = content.listType === 'icon' && content.iconUrl
			? sanitizeUrl(content.iconUrl)
			: '';

		const rows = items.map((item, i) => {
			const paddingBottom = i < items.length - 1 ? itemSpacing : 0;
			let bullet: string;
			if (content.listType === 'numbered') {
				bullet = `${i + 1}.`;
			} else if (content.listType === 'check') {
				bullet = '&#10003;';
			} else if (iconSrc) {
				bullet = `<amp-img src="${escapeAttr(iconSrc)}" alt="" width="${bulletSize}" height="${bulletSize}" layout="fixed"></amp-img>`;
			} else {
				bullet = '&#8226;';
			}
			return `<tr><td style="vertical-align:top;padding:0 8px ${paddingBottom}px 0;width:24px;font-size:${bulletSize}px;color:${escapeAttr(bulletColor)};line-height:1.5">${bullet}</td><td style="vertical-align:top;padding:0 0 ${paddingBottom}px 0;font-size:${fontSize}px;color:${escapeAttr(textColor)};line-height:1.5">${escapeHtml(item)}</td></tr>`;
		}).join('');

		return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">${rows}</table>`;
	},

	createDefault() {
		return {
			items: ['First item', 'Second item', 'Third item'],
			listType: 'bullet',
			bulletColor: '#374151',
			fontSize: 16,
			textColor: '#374151',
			itemSpacing: 6,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Table-based list rendering',
				description:
					'Lists rendered using tables instead of ul/ol for cross-client consistency',
				support: fullSupport,
				fallback: 'Lists rendered using tables for cross-client consistency',
				owlatHandled: true,
				canIEmailSlug: 'html-table',
			},
			{
				feature: 'Custom bullet icons',
				description: 'Custom image icons used as list bullets',
				support: fullSupport,
				fallback: 'N/A — uses img tags which are universally supported',
				owlatHandled: false,
				canIEmailSlug: 'html-img',
			},
		],
		properties: [
			{
				property: 'listType',
				description: 'List type (icon type requires image loading)',
				support: fullSupport,
				severity: 'info',
				recommendation:
					'Icon type depends on image loading — bullet/numbered/check are more reliable',
				owlatHandled: false,
				degradationImpact: 'visual',
			},
			{
				property: 'bulletColor',
				description: 'Custom bullet/number color',
				support: fullSupport,
				severity: 'info',
				recommendation:
					'Safe to use everywhere — rendered as inline color on table cells',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'items', check: isArray, code: 'LIST_ITEMS_TYPE', message: 'items must be an array' },
			{ field: 'listType', check: (v) => isOneOf(v, LIST_TYPES), code: 'LIST_TYPE_INVALID', message: 'listType must be bullet, numbered, check, or icon' },
		], block.id, 'list', ctx.issues);

		// Semantic
		if (!content.items || content.items.length === 0) {
			ctx.issues.push({ blockId: block.id, blockType: 'list', severity: 'warning', code: 'LIST_EMPTY', message: 'List block has no items' });
		}
		if (content.listType === 'icon' && !content.iconUrl) {
			ctx.issues.push({ blockId: block.id, blockType: 'list', severity: 'warning', code: 'LIST_ICON_NO_URL', message: 'List type is "icon" but no iconUrl is provided — will fall back to bullet' });
		}
	},
};
