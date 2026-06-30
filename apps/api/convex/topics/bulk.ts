import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getMutationContext, hasPermission, requirePermission } from '../lib/sessionOrganization';

/**
 * Bulk-add contacts to a Topic. Thin auth-bearing shell — the Topic
 * subscription (module) owns every write to `contactTopics`, the DOI gate,
 * the trigger fanout, and the (coalesced) `cachedMemberCount` patch.
 * See docs/adr/0013-topic-subscription-module.md.
 */
export const addContacts = authedMutation({
	args: {
		topicId: v.id('topics'),
		contactIds: v.array(v.id('contacts')),
		// Optional: skip DOI for this batch (admin-authoritative).
		skipDoi: v.optional(v.boolean()),
		// Optional: site URL for confirmation emails.
		siteUrl: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<string[]> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'topics:manage'), 'Only owners and admins can bulk-edit topic membership');

		const { outcomes } = await ctx.runMutation(
			internal.topics.subscription.subscribeMany,
			{
				topicId: args.topicId,
				contactIds: args.contactIds,
				source: 'admin',
				...(args.skipDoi === true ? { skipDoi: true } : {}),
				...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
			},
		);

		// Preserve the legacy return shape: array of membership IDs for
		// newly-inserted memberships only (excludes `already_member`).
		const addedIds: string[] = [];
		for (const outcome of outcomes) {
			if (
				outcome.ok &&
				(outcome.action === 'subscribed' || outcome.action === 'pending_doi')
			) {
				addedIds.push(outcome.membershipId);
			}
		}
		return addedIds;
	},
});

/**
 * Bulk-remove contacts from a Topic. Thin shell delegating to the Topic
 * subscription (module). Under this module the `cachedMemberCount` decrement
 * is coalesced (one patch per call) — closes the pre-deepening drift where
 * bulk-remove silently overstated `cachedMemberCount` by N until the daily
 * `topics.reconcileMemberCounts` cron ran.
 */
export const removeContacts = authedMutation({
	args: {
		topicId: v.id('topics'),
		contactIds: v.array(v.id('contacts')),
	},
	handler: async (ctx, args): Promise<void> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'topics:manage'), 'Only owners and admins can bulk-edit topic membership');
		await ctx.runMutation(internal.topics.subscription.unsubscribeMany, {
			topicId: args.topicId,
			contactIds: args.contactIds,
			source: 'admin',
		});
	},
});
