/**
 * Campaign deletion — the one owner of a campaign's way into Recently deleted,
 * back out of it, and out of the database (`lib/softDelete.ts`).
 *
 * Delete stamps the row and takes it out of its listing bucket; the row, its
 * Sends, stats and archive stay. A scheduled campaign is unscheduled back to
 * draft through the campaign lifecycle first, so a deleted campaign is never on
 * the send path and a restore never fires a send that was due while it was
 * deleted. Restore clears the stamp and puts the row back in its bucket.
 *
 * The purge removes the campaign row only, which is what a delete did before
 * Recently deleted existed. Children keep their policy: Sends and their tracking
 * events are delivery history (suppression, reputation and contact activity read
 * them), and the content-scan, share-link and audit rows name the campaign by
 * id without needing it.
 *
 * Both directions are idempotent: deleting a deleted campaign does not move
 * its retention clock or its counter, and restoring a live one is a no-op.
 */

import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { campaignsQuery } from './_helpers';
import { assertTransitioned } from './lifecycle';
import { recordAuditLog } from '../lib/auditLog';
import { recordListingCounter } from '../lib/listingCounters';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { purgeAt, RETENTION_PURGE_USER, type DeletionOutcome } from '../lib/softDelete';
import { throwInvalidState, throwNotFound } from '../_utils/errors';

/**
 * Move a campaign to Recently deleted. Refuses a campaign that is sending (the
 * send pipeline cannot be called back mid-flight); a scheduled one is
 * unscheduled to draft first.
 */
export async function softDeleteCampaign(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
	userId: string
): Promise<DeletionOutcome> {
	if (campaign.deletedAt !== undefined) return 'unchanged';
	if (campaign.status === 'sending') {
		throwInvalidState('Cannot delete a campaign that is currently sending');
	}

	let row = campaign;
	if (campaign.status === 'scheduled') {
		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaign._id,
			input: { to: 'draft', at: Date.now() },
			userId,
		});
		assertTransitioned(outcome, 'unschedule');
		const unscheduled = await ctx.db.get(campaign._id);
		if (!unscheduled) throwNotFound('Campaign');
		row = unscheduled;
	}

	const deletedAt = Date.now();
	await ctx.db.patch(campaign._id, { deletedAt, deletedBy: userId });
	await recordListingCounter(ctx, 'campaignStatus', row, { ...row, deletedAt });
	await recordAuditLog(ctx, {
		userId,
		action: 'campaign.deleted',
		resource: 'campaign',
		resourceId: campaign._id,
		details: { name: campaign.name },
	});
	return 'changed';
}

/** Bring a campaign back from Recently deleted, as it was when it was deleted. */
export async function restoreCampaign(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	userId: string
): Promise<DeletionOutcome> {
	const campaign = await ctx.db.get(campaignId);
	// Gone for good: the purge got to it first.
	if (!campaign) throwNotFound('Campaign');
	if (campaign.deletedAt === undefined) return 'unchanged';

	await ctx.db.patch(campaignId, { deletedAt: undefined, deletedBy: undefined });
	await recordListingCounter(ctx, 'campaignStatus', campaign, {
		...campaign,
		deletedAt: undefined,
	});
	await recordAuditLog(ctx, {
		userId,
		action: 'campaign.restored',
		resource: 'campaign',
		resourceId: campaignId,
		details: { name: campaign.name },
	});
	return 'changed';
}

/**
 * Permanently remove up to `limit` campaigns deleted before `cutoff`, oldest
 * first. `hasMore` tells the purge to come back for the rest.
 */
export async function purgeExpiredCampaigns(
	ctx: MutationCtx,
	cutoff: number,
	limit: number
): Promise<{ purged: number; hasMore: boolean }> {
	const expired = await ctx.db
		.query('campaigns')
		.withIndex('by_deleted_at_and_updated_at', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
		.take(limit + 1);
	const batch = expired.slice(0, limit);
	for (const campaign of batch) {
		await ctx.db.delete(campaign._id);
		await recordAuditLog(ctx, {
			userId: RETENTION_PURGE_USER,
			action: 'campaign.purged',
			resource: 'campaign',
			resourceId: campaign._id,
			details: { name: campaign.name },
		});
	}
	return { purged: batch.length, hasMore: expired.length > limit };
}

/**
 * The campaigns in Recently deleted, most recently deleted first. Restoring
 * needs `campaigns:manage`, the permission a delete needs, so the list does too.
 */
export const listDeleted = campaignsQuery({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'campaigns:manage'),
			'You do not have permission to restore campaigns'
		);
		const result = await ctx.db
			.query('campaigns')
			.withIndex('by_deleted_at_and_updated_at', (q) => q.gte('deletedAt', 0))
			.order('desc')
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map((campaign) => ({
				_id: campaign._id,
				name: campaign.name,
				status: campaign.status,
				deletedAt: campaign.deletedAt ?? 0,
				purgeAt: purgeAt(campaign.deletedAt ?? 0),
			})),
		};
	},
});
