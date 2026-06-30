import { v } from 'convex/values';
import { internalQuery } from './_generated/server';

/**
 * Get share link data by token.
 * Returns null if not found or revoked, { expired: true } if expired,
 * or full share link data if valid.
 */
export const getShareLinkByToken = internalQuery({
	args: { token: v.string() },
	handler: async (ctx, args) => {
		const shareLink = await ctx.db
			.query('shareLinks')
			.withIndex('by_token', (q) => q.eq('token', args.token))
			.first();

		if (!shareLink) return null;
		if (shareLink.revokedAt) return null;

		if (shareLink.expiresAt < Date.now()) {
			return { expired: true as const };
		}

		// Get instance display name
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		return {
			html: shareLink.htmlContent,
			subject: shareLink.subject,
			previewText: shareLink.previewText,
			organizationName: settings?.defaultFromName ?? 'Unknown',
			expiresAt: shareLink.expiresAt,
		};
	},
});
