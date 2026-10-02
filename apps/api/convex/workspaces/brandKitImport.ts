'use node';

/**
 * Brand kit "Import from website" — Node runtime, because every fetch goes
 * through the SSRF guard (`lib/ssrfGuard.ts`), which needs `dns`/`net`.
 *
 *   - `importFromWebsite` fetches the page an admin names (and up to three of
 *     its stylesheets) and returns a proposed kit. It saves nothing: the admin
 *     reviews the proposal on the settings page and saves the kit from there.
 *   - `importLogo` downloads the logo candidate the admin accepted into the
 *     media library and returns the new asset, for the form to use.
 *
 * Both require `settings:manage` and share one per-user rate limit. Bodies are
 * read through capped readers with a timeout; redirects are followed by hand,
 * a few hops at most, each hop checked by the guard again.
 */

import { v } from 'convex/values';
import { readStreamPrefix } from '@owlat/shared';
import {
	MAX_WORKSPACE_LOGO_BYTES,
	isWorkspaceLogoMimeType,
	workspaceLogoBytesProblem,
} from '@owlat/shared/workspaceLogo';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedAction } from '../lib/authedFunctions';
import { rateLimiter } from '../lib/rateLimiter';
import { fetchGuarded, SsrfBlockedError } from '../lib/ssrfGuard';
import {
	countCssColors,
	extractWebsiteSignals,
	proposeBrandKit,
	resolveHttpUrl,
	type BrandProposal,
} from './brandKitWebsite';

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_STYLESHEET_BYTES = 512 * 1024;
/** Four times the workspace logo cap: an og:image is often a large photo. */
const MAX_IMAGE_BYTES = 4 * MAX_WORKSPACE_LOGO_BYTES;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;

export type ImportError =
	| 'rate_limited'
	| 'invalid_url'
	| 'blocked'
	| 'unreachable'
	| 'not_html'
	| 'not_image'
	| 'too_large';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ImportError };

/** Who is importing, after the permission check and the rate limit. */
async function admit(
	ctx: ActionCtx
): Promise<{ userId: string; activeOrganizationId: string } | null> {
	const who = await ctx.runQuery(internal.workspaces.brandKit.assertCanManage, {});
	const limit = await rateLimiter.limit(ctx, 'brandKitImport', { key: who.userId });
	return limit.ok ? who : null;
}

/**
 * What an admin typed, as an absolute http(s) URL (`example.com` means https).
 * Only `scheme://` counts as a scheme, so `example.com:8443` is a host and port.
 */
function normalizeSiteUrl(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return resolveHttpUrl(withScheme, withScheme);
}

/** Drop a body nobody reads; a stream that already failed has nothing to cancel. */
async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

/** GET `url` through the SSRF guard, following a few redirects (each re-checked). */
async function fetchFollowing(
	url: string,
	accept: string
): Promise<Outcome<{ response: Response; url: string }>> {
	let response: Response;
	try {
		response = await fetchGuarded(url, {
			headers: { accept, 'user-agent': 'Owlat brand kit import' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			maxRedirects: MAX_REDIRECTS,
		});
	} catch (error) {
		return { ok: false, error: error instanceof SsrfBlockedError ? 'blocked' : 'unreachable' };
	}
	if (!response.ok) {
		await discard(response);
		return { ok: false, error: 'unreachable' };
	}
	// The URL the body came from, after redirects, resolves the page's links.
	return { ok: true, value: { response, url: response.url || url } };
}

/**
 * The body's first `maxBytes`, or `null` when the body fails mid-read (the
 * fetch's timeout fires, the connection drops).
 */
async function readBody(
	response: Response,
	maxBytes: number
): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean } | null> {
	try {
		return await readStreamPrefix(response.body, maxBytes, { timeoutMs: FETCH_TIMEOUT_MS });
	} catch {
		return null;
	}
}

/** The body as text, or `null` when it could not be read. */
async function readText(response: Response, maxBytes: number): Promise<string | null> {
	const prefix = await readBody(response, maxBytes);
	// A page cut at the cap still carries its <head>, which is what matters.
	return prefix ? new TextDecoder('utf-8').decode(prefix.bytes) : null;
}

/**
 * Fetch a website and propose a brand kit from it: theme colour, logo
 * candidates, name and the colours its CSS uses most. Saves nothing.
 */
// authz: settings:manage via internal.workspaces.brandKit.assertCanManage
export const importFromWebsite = authedAction({
	args: { url: v.string() },
	handler: async (ctx, args): Promise<Outcome<BrandProposal & { url: string }>> => {
		if (!(await admit(ctx))) return { ok: false, error: 'rate_limited' };
		const url = normalizeSiteUrl(args.url);
		if (!url) return { ok: false, error: 'invalid_url' };

		const page = await fetchFollowing(url, 'text/html');
		if (!page.ok) return page;
		const type = page.value.response.headers.get('content-type') ?? '';
		if (!/text\/html|application\/xhtml/i.test(type)) {
			await discard(page.value.response);
			return { ok: false, error: 'not_html' };
		}
		const html = await readText(page.value.response, MAX_PAGE_BYTES);
		if (html === null) return { ok: false, error: 'unreachable' };
		const signals = extractWebsiteSignals(html, page.value.url);

		// Linked stylesheets carry most of a site's colours. One that fails is
		// skipped: the page's own CSS still counts.
		const sheets = await Promise.all(
			signals.stylesheetUrls.map(async (sheetUrl) => {
				const sheet = await fetchFollowing(sheetUrl, 'text/css');
				return sheet.ok ? ((await readText(sheet.value.response, MAX_STYLESHEET_BYTES)) ?? '') : '';
			})
		);
		const colors = countCssColors([signals.inlineCss, ...sheets].join('\n'));
		return { ok: true, value: { ...proposeBrandKit(signals, colors), url: page.value.url } };
	},
});

function filenameFor(url: string, mimeType: string): string {
	const extension = mimeType === 'image/svg+xml' ? 'svg' : mimeType === 'image/png' ? 'png' : 'jpg';
	let host = 'website';
	try {
		host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '') || host;
	} catch {
		// keep the fallback
	}
	return `${host}-logo.${extension}`;
}

/**
 * Download an accepted logo candidate into the media library. Only PNG, JPEG
 * and script-free SVG are taken, checked by their bytes, as for the
 * workspace logo.
 */
// authz: settings:manage via internal.workspaces.brandKit.assertCanManage
export const importLogo = authedAction({
	args: { url: v.string() },
	handler: async (
		ctx,
		args
	): Promise<Outcome<{ mediaAssetId: Id<'mediaAssets'>; url: string; storageId: string }>> => {
		const who = await admit(ctx);
		if (!who) return { ok: false, error: 'rate_limited' };
		const url = normalizeSiteUrl(args.url);
		if (!url) return { ok: false, error: 'invalid_url' };

		const fetched = await fetchFollowing(url, 'image/png,image/jpeg,image/svg+xml');
		if (!fetched.ok) return fetched;
		const mimeType = (fetched.value.response.headers.get('content-type') ?? '')
			.split(';')[0]!
			.trim()
			.toLowerCase();
		if (!isWorkspaceLogoMimeType(mimeType)) {
			await discard(fetched.value.response);
			return { ok: false, error: 'not_image' };
		}
		const prefix = await readBody(fetched.value.response, MAX_IMAGE_BYTES);
		if (!prefix) return { ok: false, error: 'unreachable' };
		if (prefix.truncated) return { ok: false, error: 'too_large' };
		if (workspaceLogoBytesProblem(mimeType, prefix.bytes) !== null) {
			return { ok: false, error: 'not_image' };
		}

		const storageId = await ctx.storage.store(new Blob([prefix.bytes], { type: mimeType }));
		try {
			const asset = await ctx.runMutation(internal.workspaces.brandKit.registerFetchedImage, {
				storageId,
				filename: filenameFor(fetched.value.url, mimeType),
				mimeType,
				userId: who.userId,
				organizationId: who.activeOrganizationId,
			});
			return { ok: true, value: { ...asset, storageId } };
		} catch (error) {
			// Nothing references the blob yet; do not leave it behind.
			await ctx.storage.delete(storageId);
			throw error;
		}
	},
});
