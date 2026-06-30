/**
 * Campaign archive HTTP endpoint — GET /archive/{token}. Returns the
 * snapshotted HTML of a sent campaign with archive enabled. Wrapped by the
 * **Public token endpoint (module)** for the uniform shell shape.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { internal } from '../_generated/api';
import { publicTokenEndpoint } from '../lib/publicTokenEndpoint';

interface ArchiveData {
	html: string;
	subject: string;
	sentAt: number;
	organizationName: string;
}

/**
 * GET /archive/{token}.
 */
export const getCampaignArchive = publicTokenEndpoint(
	{
		path: '/archive/:token',
		method: 'GET',
		rateLimit: 'subscriptionManagement',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token }) => {
		const archive = await ctx.runQuery<ArchiveData | null>(
			internal.campaigns.archiveQueries.getCampaignByArchiveToken,
			{ archiveToken: token },
		);

		if (!archive) {
			return {
				ok: false,
				reason: 'archive_not_found',
				message: 'Archive not found',
				status: 404,
			};
		}

		return {
			ok: true,
			headers: { 'Cache-Control': 'public, max-age=3600' },
			data: {
				html: archive.html,
				subject: archive.subject,
				sentAt: archive.sentAt,
				organizationName: archive.organizationName,
			},
		};
	},
);
