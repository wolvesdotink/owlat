import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { resolveStoredFeatureFlags } from '../lib/featureFlags';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';

/**
 * Get campaign archive data by archive token.
 * Only returns data for sent campaigns with archiveEnabled: true, and only
 * while the `campaigns` feature is on. `campaigns.archive` is not checked
 * here: send.ts reads it as the default for campaigns that leave
 * archiveEnabled unset, and a campaign's own setting overrides it.
 */
export const getCampaignByArchiveToken = internalQuery({
	args: { archiveToken: v.string() },
	handler: async (ctx, args) => {
		const campaign = await ctx.db
			.query('campaigns')
			.withIndex('by_archive_token', (q) => q.eq('archiveToken', args.archiveToken))
			.first();

		if (!campaign) return null;
		if (campaign.status !== 'sent') return null;
		if (!campaign.archiveEnabled) return null;
		if (!campaign.archiveHtmlContent) return null;

		// Get instance display name
		const orgSettings = await ctx.db.query('instanceSettings').first();
		const flags = resolveStoredFeatureFlags((orgSettings?.featureFlags ?? {}) as FeatureFlagState);
		if (!flags.campaigns) return null;

		return {
			html: campaign.archiveHtmlContent,
			subject: campaign.archiveSubject ?? campaign.subject ?? campaign.name,
			sentAt: campaign.sentAt,
			organizationName: orgSettings?.defaultFromName ?? 'Unknown',
		};
	},
});

/**
 * Store archive snapshot on a campaign (called during send flow).
 */
export const setArchiveSnapshot = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		archiveToken: v.string(),
		archiveHtmlContent: v.string(),
		archiveSubject: v.string(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.campaignId, {
			archiveToken: args.archiveToken,
			archiveHtmlContent: args.archiveHtmlContent,
			archiveSubject: args.archiveSubject,
			updatedAt: Date.now(),
		});
	},
});
