/**
 * Share link HTTP endpoint — GET /share/{token}. Returns the snapshotted
 * HTML preview, subject, etc. for the campaign / template the share link
 * points at. Wrapped by the **Public token endpoint (module)** for the
 * uniform shell shape.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { internal } from './_generated/api';
import { publicTokenEndpoint } from './lib/publicTokenEndpoint';

interface ShareLinkData {
	html: string;
	subject: string;
	previewText?: string;
	organizationName: string;
	expiresAt: number;
}

type ShareLinkResult = ShareLinkData | { expired: true } | null;

/**
 * GET /share/{token}.
 */
export const getShareLink = publicTokenEndpoint(
	{
		path: '/share/:token',
		method: 'GET',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token }) => {
		const result = await ctx.runQuery<ShareLinkResult>(
			internal.shareLinkQueries.getShareLinkByToken,
			{ token },
		);

		if (!result) {
			return {
				ok: false,
				reason: 'share_link_not_found',
				message: 'Share link not found',
				status: 404,
			};
		}

		if ('expired' in result) {
			return {
				ok: false,
				reason: 'expired',
				// An expired link is effectively gone. The Operation error taxonomy
				// (packages/shared/operationError.ts) is a closed set with no 410/Gone
				// category — 410 fell through publicTokenEndpoint's status→category map
				// to invalid_input (400), misrepresenting an expired link as a bad
				// request. 404 is the taxonomy-supported status that matches "this
				// link no longer resolves"; the `expired` reason still rides in data.
				message: 'This share link has expired',
				status: 404,
			};
		}

		return {
			ok: true,
			headers: { 'Cache-Control': 'no-store' },
			data: {
				html: result.html,
				subject: result.subject,
				previewText: result.previewText,
				organizationName: result.organizationName,
				expiresAt: result.expiresAt,
			},
		};
	},
);
