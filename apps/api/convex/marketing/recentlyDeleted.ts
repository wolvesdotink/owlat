/**
 * The Recently deleted purge: once a day, campaigns, automations and email
 * templates that have sat in Recently deleted for the retention window
 * (`SOFT_DELETE_RETENTION_MS`, 30 days) are removed for good.
 *
 * Each kind's removal belongs to its domain's `deletion.ts`; this module only
 * bounds and drives them. One call removes at most `PURGE_BATCH` rows of each
 * kind, all of them (and what hangs off them) within one shared row and byte
 * budget (`purgeBudget`), and schedules itself again while any kind has more,
 * so a large backlog drains over several small transactions instead of one
 * that hits Convex's limits. A row whose children outrun the budget is resumed
 * by the next call. A row restored before the purge reaches it simply leaves
 * the range.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { resolveNow } from '../lib/clock';
import { purgeBudget, SOFT_DELETE_RETENTION_MS } from '../lib/softDelete';
import { purgeExpiredCampaigns } from '../campaigns/deletion';
import { purgeExpiredAutomations } from '../automations/deletion';
import { purgeExpiredTemplates } from '../emailTemplates/deletion';

/** Rows of each kind removed per transaction. */
export const PURGE_BATCH = 25;

export const purgeExpired = internalMutation({
	args: {
		// The instant the retention is measured from; the real clock when absent.
		now: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = resolveNow(args.now);
		const cutoff = now - SOFT_DELETE_RETENTION_MS;
		const budget = purgeBudget();
		const campaigns = await purgeExpiredCampaigns(ctx, cutoff, PURGE_BATCH, budget);
		const automations = await purgeExpiredAutomations(ctx, cutoff, PURGE_BATCH, budget);
		const templates = await purgeExpiredTemplates(ctx, cutoff, PURGE_BATCH, budget);
		const hasMore = campaigns.hasMore || automations.hasMore || templates.hasMore;
		if (hasMore) {
			// The same instant, so the continuation finishes exactly this run's range.
			await ctx.scheduler.runAfter(0, internal.marketing.recentlyDeleted.purgeExpired, { now });
		}
		return {
			campaigns: campaigns.purged,
			automations: automations.purged,
			templates: templates.purged,
			hasMore,
		};
	},
});
