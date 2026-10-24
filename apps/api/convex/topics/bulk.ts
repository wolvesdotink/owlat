import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { hasPermission, requireOrgPermission, requirePermission } from '../lib/sessionOrganization';
import {
	addedMembershipValidator,
	removedMembershipValidator,
	type AddedMembership,
	type RemovedMembership,
} from './subscription';

const BULK_EDIT_DENIED = 'Only owners and admins can bulk-edit topic membership';

/**
 * Bulk-add contacts to a Topic. Thin auth-bearing shell — the Topic
 * subscription (module) owns every write to `contactTopics`, the DOI gate,
 * the trigger fanout, and the (coalesced) `cachedMemberCount` patch.
 *
 * Returns the undo receipt: the memberships this call actually inserted (an
 * existing member is not in it), each with the global opt-out it lifted, for
 * `undoAddContacts`. Its length is the number of contacts the call added.
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
	handler: async (ctx, args): Promise<{ added: AddedMembership[] }> => {
		await requireOrgPermission(ctx, 'topics:manage', BULK_EDIT_DENIED);

		const { outcomes } = await ctx.runMutation(internal.topics.subscription.subscribeMany, {
			topicId: args.topicId,
			contactIds: args.contactIds,
			source: 'admin',
			...(args.skipDoi === true ? { skipDoi: true } : {}),
			...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
		});

		// `subscribeMany` returns one outcome per contact id, in argument order.
		const added: AddedMembership[] = [];
		for (const [i, outcome] of outcomes.entries()) {
			if (!outcome.ok) continue;
			const contactId = args.contactIds[i]!;
			if (outcome.action === 'subscribed') {
				added.push({
					membershipId: outcome.membershipId,
					contactId,
					...(outcome.liftedOptOutAt !== undefined
						? { liftedOptOutAt: outcome.liftedOptOutAt }
						: {}),
				});
			} else if (outcome.action === 'pending_doi') {
				added.push({ membershipId: outcome.membershipId, contactId });
			}
		}
		return { added };
	},
});

/**
 * Bulk-remove contacts from a Topic. Thin shell delegating to the Topic
 * subscription (module). Under this module the `cachedMemberCount` decrement
 * is coalesced (one patch per call) — closes the pre-deepening drift where
 * bulk-remove silently overstated `cachedMemberCount` by N until the daily
 * `topics.reconcileMemberCounts` cron ran.
 *
 * Returns the undo receipt: the memberships this call actually deleted (a
 * non-member is not in it), as they were, for `undoRemoveContacts`.
 */
export const removeContacts = authedMutation({
	args: {
		topicId: v.id('topics'),
		contactIds: v.array(v.id('contacts')),
	},
	handler: async (ctx, args): Promise<{ removed: RemovedMembership[] }> => {
		await requireOrgPermission(ctx, 'topics:manage', BULK_EDIT_DENIED);
		const { removed } = await ctx.runMutation(internal.topics.subscription.unsubscribeMany, {
			topicId: args.topicId,
			contactIds: args.contactIds,
			source: 'admin',
		});
		return { removed };
	},
});

/**
 * Undo a bulk add from its receipt (see `revertSubscribeMany`). Needs the
 * permission the add needed.
 */
export const undoAddContacts = authedMutation({
	args: {
		topicId: v.id('topics'),
		added: v.array(addedMembershipValidator),
	},
	handler: async (ctx, args, session): Promise<{ reverted: number }> => {
		requirePermission(hasPermission(session.role, 'topics:manage'), BULK_EDIT_DENIED);
		return await ctx.runMutation(internal.topics.subscription.revertSubscribeMany, {
			topicId: args.topicId,
			added: args.added,
		});
	},
});

/**
 * Undo a bulk remove from its receipt (see `restoreMemberships`). Needs the
 * permission the remove needed.
 */
export const undoRemoveContacts = authedMutation({
	args: {
		topicId: v.id('topics'),
		removed: v.array(removedMembershipValidator),
	},
	handler: async (ctx, args, session): Promise<{ restored: number }> => {
		requirePermission(hasPermission(session.role, 'topics:manage'), BULK_EDIT_DENIED);
		return await ctx.runMutation(internal.topics.subscription.restoreMemberships, {
			topicId: args.topicId,
			removed: args.removed,
		});
	},
});
