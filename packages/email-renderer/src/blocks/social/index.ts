/**
 * Block module: social.
 *
 * Renders enabled social-platform icons either as a horizontal row of
 * inline-block links (Apple Mail) wrapped in MSO conditional comments for
 * Outlook, or as a single-column vertical stack.
 *
 * Root placement only — the historical `renderColumnItem` switch did not
 * accept social blocks.
 */

import { fullSupport, SOCIAL_PLATFORMS, type SocialBlockContent, type SocialPlatform } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { escapeAttr, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, isString, isNumber, isArray, isOneOf } from '../../helpers/validation';

const SOCIAL_ALIGNS = ['left', 'center', 'right'] as const;
const SOCIAL_ICON_STYLES = ['filled', 'outline'] as const;

const PLATFORM_NAMES: Record<SocialPlatform, string> = Object.fromEntries(
	(Object.entries(SOCIAL_PLATFORMS) as [SocialPlatform, { label: string }][]).map(([value, m]) => [value, m.label]),
) as Record<SocialPlatform, string>;

const getDefaultIconUrl = (platform: SocialPlatform, style: 'filled' | 'outline'): string =>
	`/social-icons/${style}/${platform}.png`;

const renderIconImg = (iconSrc: string, name: string, iconSize: number): string => {
	const safeName = escapeAttr(name);
	if (iconSrc) {
		const safeSrc = escapeAttr(sanitizeUrl(iconSrc));
		return `<img src="${safeSrc}" alt="${safeName}" width="${iconSize}" height="${iconSize}" style="display:block;border:0;outline:none;margin:0 auto;width:${iconSize}px;height:${iconSize}px" border="0" />`;
	}
	return `<span aria-label="${safeName}" style="display:inline-block;width:${iconSize}px;height:${iconSize}px;line-height:${iconSize}px;text-align:center;font-size:${Math.max(11, iconSize - 10)}px;font-family:Arial,sans-serif">${name.charAt(0)}</span>`;
};

/**
 * The inner social-icon HTML. Exported because XSS regression tests and the
 * legacy unit suite assert on its output directly.
 */
export const renderSocialContent = (content: SocialBlockContent): string => {
	const enabledLinks = content.links.filter((link) => link.enabled && link.url);
	if (enabledLinks.length === 0) return '';

	const halfSpacing = Math.floor(content.iconSpacing / 2);
	const isVertical = content.mode === 'vertical';

	if (isVertical) {
		const rows = enabledLinks
			.map((link) => {
				const name = PLATFORM_NAMES[link.platform] || link.platform;
				const iconSrc = link.iconUrl || getDefaultIconUrl(link.platform, content.iconStyle);
				const imgTag = renderIconImg(iconSrc, name, content.iconSize);
				const safeUrl = escapeAttr(sanitizeUrl(link.url));
				const cellContent = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${imgTag}</a>`;
				return `<tr><td style="padding:${halfSpacing}px 0;text-align:${content.align}">${cellContent}</td></tr>`;
			})
			.join('');
		return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${content.align}">${rows}</table>`;
	}

	const iconBlocks = enabledLinks
		.map((link) => {
			const name = PLATFORM_NAMES[link.platform] || link.platform;
			const iconSrc = link.iconUrl || getDefaultIconUrl(link.platform, content.iconStyle);
			const imgTag = renderIconImg(iconSrc, name, content.iconSize);
			const safeUrl = escapeAttr(sanitizeUrl(link.url));
			return `<!--[if mso | IE]><td style="vertical-align:top;padding:0 ${halfSpacing}px"><![endif]--><div style="display:inline-block;vertical-align:top;text-align:center;padding:0 ${halfSpacing}px"><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${imgTag}</a></div><!--[if mso | IE]></td><![endif]-->`;
		})
		.join('');

	const alignStyle = content.align === 'left' ? 'text-align:left' : content.align === 'right' ? 'text-align:right' : 'text-align:center';
	return `<div style="${alignStyle};font-size:0;word-spacing:normal"><!--[if mso | IE]><table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${content.align}"><tr><![endif]-->${iconBlocks}<!--[if mso | IE]></tr></table><![endif]--></div>`;
};

export const socialModule: BlockModule<'social'> = {
	type: 'social',
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return content.links.every((link) => !link.enabled || !link.url);
	},

	html({ block, content, ctx }) {
		const transformed = ctx.linkTransform
			? { ...content, links: content.links.map((link) => ({
					...link,
					url: link.url ? transformUrl(link.url, 'social', block.id, ctx) : link.url,
				})) }
			: content;
		return renderSocialContent(transformed);
	},

	plaintext({ content }) {
		return content.links
			.filter((link) => link.enabled && link.url)
			.map((link) => `${link.platform}: ${link.url}`)
			.join('\n');
	},

	amp({ content }) {
		// AMP4Email forbids raw <img>, so each icon becomes an <amp-img>. We use
		// a single-row table of linked icons rather than the MSO inline-block
		// markup, which AMP does not need.
		const enabledLinks = content.links.filter((link) => link.enabled && link.url);
		if (enabledLinks.length === 0) return '';

		const size = content.iconSize;
		const halfSpacing = Math.floor(content.iconSpacing / 2);

		const cells = enabledLinks.map((link) => {
			const name = escapeAttr(PLATFORM_NAMES[link.platform] || link.platform);
			const iconSrc = escapeAttr(sanitizeUrl(link.iconUrl || getDefaultIconUrl(link.platform, content.iconStyle)));
			const safeUrl = escapeAttr(sanitizeUrl(link.url));
			const img = `<amp-img src="${iconSrc}" alt="${name}" width="${size}" height="${size}" layout="fixed"></amp-img>`;
			return `<td style="padding:0 ${halfSpacing}px"><a href="${safeUrl}">${img}</a></td>`;
		}).join('');

		return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${content.align}"><tr>${cells}</tr></table>`;
	},

	createDefault() {
		return {
			links: [
				{ platform: 'twitter', url: '', enabled: true },
				{ platform: 'facebook', url: '', enabled: true },
				{ platform: 'instagram', url: '', enabled: true },
				{ platform: 'linkedin', url: '', enabled: true },
				{ platform: 'youtube', url: '', enabled: false },
			],
			iconStyle: 'filled',
			align: 'center',
			iconSize: 64,
			iconSpacing: 12,
			iconColor: '#374151',
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Icon rendering',
				description: 'Social media icons display',
				support: fullSupport,
				fallback: 'Social icons rendered as img tags for universal support',
				owlatHandled: true,
				canIEmailSlug: 'html-img',
			},
			{
				feature: 'Vertical mode',
				description: 'Social icons stacked vertically',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
			},
			{
				feature: 'Show labels',
				description: 'Platform name text labels next to icons',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
			},
		],
		properties: [
			{
				property: 'mode',
				description: 'Layout mode (horizontal or vertical)',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Safe to use everywhere',
				owlatHandled: false,
			},
			{
				property: 'showLabels',
				description: 'Show platform name text labels',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Safe to use everywhere',
				owlatHandled: false,
			},
			{
				property: 'iconUrl',
				description: 'Custom icon URL for social links',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Use PNG icons at 32x32px or larger for retina clarity',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'links', check: isArray, code: 'SOCIAL_LINKS_TYPE', message: 'links must be an array' },
			{ field: 'iconStyle', check: (v) => isOneOf(v, SOCIAL_ICON_STYLES), code: 'SOCIAL_ICON_STYLE_INVALID', message: 'iconStyle must be filled or outline' },
			{ field: 'align', check: (v) => isOneOf(v, SOCIAL_ALIGNS), code: 'SOCIAL_ALIGN_INVALID', message: 'align must be left, center, or right' },
			{ field: 'iconSize', check: isNumber, code: 'SOCIAL_ICON_SIZE_TYPE', message: 'iconSize must be a number' },
			{ field: 'iconSpacing', check: isNumber, code: 'SOCIAL_ICON_SPACING_TYPE', message: 'iconSpacing must be a number' },
			{ field: 'iconColor', check: isString, code: 'SOCIAL_ICON_COLOR_TYPE', message: 'iconColor must be a string' },
		], block.id, 'social', ctx.issues);
	},
};
