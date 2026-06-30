'use node';

import * as cheerio from 'cheerio';
import { createHmac } from 'node:crypto';
import { getOptional } from '../../lib/env';

/**
 * Send composition (module) — transform half.
 *
 * Single DOM-pass injection of campaign-time transformations onto the
 * personalized HTML body. Runs in Node (cheerio is a Node-only dependency).
 *
 * Replaces the pre-deepening inline `transformEmailHtml` in `emailWorker.ts`
 * (75 LOC) — function body is byte-identical; only the location and the
 * config field names change.
 *
 * Each per-kind composer in `sendComposition/<kind>/` declares the
 * `TransformConfig` for its kind (or returns `null` for kinds that ship
 * unmodified HTML). The worker applies whatever config the composer hands
 * it; the worker is policy-agnostic.
 */

export interface TransformConfig {
	/** Branded tracking host the click handler hangs off (defaults to convex
	 * site URL). The composer derives this from `trackingBaseUrl` and writes
	 * it into both halves of the tracked-link config. */
	trackedLinkBase?: { siteUrl: string; emailSendId: string };
	/** Full tracking pixel URL, ready to drop into the `<img src>`. */
	trackingPixelUrl?: string;
	/** Pre-built `/unsubscribe?token=...` URL (composer signs the token). */
	unsubscribeUrl?: string;
	/** Pre-built `/preferences?token=...` URL (composer signs the token). */
	preferenceUrl?: string;
	/** Pre-built `/archive?token=...` URL. */
	viewInBrowserUrl?: string;
}

/**
 * Inject view-in-browser, footer, link-tracking, and tracking-pixel content
 * onto the HTML body in a single cheerio pass.
 *
 * Order of operations (load-bearing):
 *   1. View-in-browser link prepended to body
 *   2. Footer appended to body (so footer links can be tracked in step 3)
 *   3. Link wrapping (skips mailto:, tel:, #anchors, javascript:, already-tracked /t/c/)
 *   4. Tracking pixel appended to body
 */
export function transformHtml(html: string, config: TransformConfig): string {
	const $ = cheerio.load(html);

	// 0. Inject "View in browser" link at top of email
	if (config.viewInBrowserUrl) {
		const viewInBrowserHtml = `<div style="text-align:center;font-size:11px;color:#999;padding:8px 0 4px"><a href="${config.viewInBrowserUrl}" data-no-track style="color:#999;text-decoration:underline">View in browser</a></div>`;
		const $body = $('body');
		if ($body.length > 0) {
			$body.prepend(viewInBrowserHtml);
		} else {
			$.root().prepend(viewInBrowserHtml);
		}
	}

	// 1. Inject footer first (so footer links get tracked in step 2)
	if (config.unsubscribeUrl && config.preferenceUrl) {
		const footerHtml = `
<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #6b7280;">
  <p style="margin: 0;">
    <a href="${config.preferenceUrl}" style="color: #6b7280; text-decoration: underline;">Manage Preferences</a>
    &nbsp;&middot;&nbsp;
    <a href="${config.unsubscribeUrl}" style="color: #6b7280; text-decoration: underline;">Unsubscribe</a>
  </p>
</div>`;
		const $body = $('body');
		if ($body.length > 0) {
			$body.append(footerHtml);
		} else {
			$.root().append(footerHtml);
		}
	}

	// 2. Wrap trackable links (including footer links added above)
	if (config.trackedLinkBase) {
		const { siteUrl, emailSendId } = config.trackedLinkBase;
		// Secret used to HMAC-bind each redirect target to its emailSendId so the
		// click handler can't be turned into an open redirect (a recipient
		// swapping the encoded-URL segment for an arbitrary host). Reuse the
		// public-link signing secret. If it is somehow unset we leave links
		// untracked rather than emit an unsigned (forgeable) tracking URL.
		const trackingSecret = getOptional('UNSUBSCRIBE_SECRET');
		$('a[href]').each((_index, element) => {
			const $link = $(element);
			const href = $link.attr('href');
			if (!href) return;

			// Skip links marked with data-no-track (e.g., view-in-browser)
			if ($link.attr('data-no-track') !== undefined) {
				$link.removeAttr('data-no-track');
				return;
			}

			const lowerUrl = href.toLowerCase();

			// Skip non-trackable links
			if (
				lowerUrl.startsWith('mailto:') ||
				lowerUrl.startsWith('tel:') ||
				lowerUrl.startsWith('#') ||
				lowerUrl.startsWith('javascript:') ||
				lowerUrl.includes('/t/c/')
			) {
				return;
			}

			if (!trackingSecret) return; // no secret → leave the link untracked

			// Replace with tracked URL — inlined to avoid importing the V8 leaf
			// from this 'use node' module. base64url is built-in on Buffer.
			// `/t/c/{id}/{encodedUrl}/{sig}` — the signature over `id.encodedUrl`
			// binds the target to this send; the click handler rejects any
			// tampered/unsigned segment (closing the open-redirect vector).
			const encodedUrl = Buffer.from(href, 'utf-8').toString('base64url');
			const sig = createHmac('sha256', trackingSecret)
				.update(`${emailSendId}.${encodedUrl}`)
				.digest('base64url');
			$link.attr('href', `${siteUrl}/t/c/${emailSendId}/${encodedUrl}/${sig}`);
		});
	}

	// 3. Inject tracking pixel last (after all content)
	if (config.trackingPixelUrl) {
		const trackingPixelHtml = `<img src="${config.trackingPixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
		const $body = $('body');
		if ($body.length > 0) {
			$body.append(trackingPixelHtml);
		} else {
			$.root().append(trackingPixelHtml);
		}
	}

	return $.html();
}
