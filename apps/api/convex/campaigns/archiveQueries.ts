import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { resolveStoredFeatureFlags } from '../lib/featureFlags';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import { isLive } from '../lib/softDelete';
import { findPreparedSendJob } from './sendJob';

/**
 * Get campaign archive data by archive token.
 * Only returns data for live (not deleted) sent campaigns with archiveEnabled: true, and only
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

		// A deleted campaign's public archive goes with it (and comes back on restore).
		if (!isLive(campaign)) return null;
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

/** The public archive copy of a campaign, written once per send. */
export interface ArchiveSnapshot {
	readonly archiveToken: string;
	readonly archiveHtmlContent: string;
	readonly archiveSubject: string;
}

/**
 * Store archive snapshot on a campaign. The send preparation commit writes it
 * through `writeArchiveSnapshot`; this mutation is what a preparation action
 * of the previous release calls. Once the new commit prepared the send, the
 * walker is already sending its archive link, so a late call from such an
 * action must not replace the token those emails point at.
 */
export const setArchiveSnapshot = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		archiveToken: v.string(),
		archiveHtmlContent: v.string(),
		archiveSubject: v.string(),
	},
	handler: async (ctx, { campaignId, ...snapshot }) => {
		if (await findPreparedSendJob(ctx, campaignId)) return;
		await writeArchiveSnapshot(ctx, campaignId, snapshot, Date.now());
	},
});

/** `setArchiveSnapshot` inside the caller's transaction. */
export async function writeArchiveSnapshot(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	snapshot: ArchiveSnapshot,
	now: number
): Promise<void> {
	await ctx.db.patch(campaignId, {
		archiveToken: snapshot.archiveToken,
		archiveHtmlContent: snapshot.archiveHtmlContent,
		archiveSubject: snapshot.archiveSubject,
		updatedAt: now,
	});
}
