/**
 * Shared link-transform helpers. Block modules that emit `<a href>` apply these
 * to give callers a single chokepoint for UTM injection, click tracking, etc.
 *
 * Both functions are no-ops when `ctx.linkTransform` is undefined.
 */

import type { RenderContext } from '../types';
import { sanitizeUrl, escapeAttr } from '../sanitize';

/**
 * Apply `ctx.linkTransform` to a URL if configured, then re-sanitize the result
 * to block javascript:/data: injection through a malicious transform.
 */
export const transformUrl = (url: string, blockType: string, blockId: string, ctx: RenderContext): string => {
	if (!ctx.linkTransform || !url) return url;
	const transformed = ctx.linkTransform(url, { blockType, blockId });
	return sanitizeUrl(transformed);
};

/**
 * Walk every `href` in an HTML fragment (text-block rich-text output) through
 * `transformUrl`. Used by text/button/menu/social blocks that embed links.
 */
export const transformHtmlLinks = (html: string, blockType: string, blockId: string, ctx: RenderContext): string => {
	if (!ctx.linkTransform) return html;
	return html.replace(/href="([^"]*)"/g, (_match, url: string) => {
		return `href="${escapeAttr(transformUrl(url, blockType, blockId, ctx))}"`;
	});
};
