import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { isFeatureEnabled } from './lib/featureFlags';

/**
 * Get share link data by token.
 * Returns null if not found or revoked (or, for a transactional email, while
 * the transactional feature is off), { expired: true } if expired,
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
		// A transactional email's preview follows the transactional feature flag,
		// like its editor. Email templates belong to the always-on editor.
		if (
			shareLink.targetType === 'transactionalEmail' &&
			!(await isFeatureEnabled(ctx, 'transactional'))
		) {
			return null;
		}

		if (shareLink.expiresAt < Date.now()) {
			return { expired: true as const };
		}

		// Get instance display name
		const settings = await ctx.db.query('instanceSettings').first();

		return {
			html: shareLink.htmlContent,
			subject: shareLink.subject,
			previewText: shareLink.previewText,
			organizationName: settings?.defaultFromName ?? 'Unknown',
			expiresAt: shareLink.expiresAt,
		};
	},
});
