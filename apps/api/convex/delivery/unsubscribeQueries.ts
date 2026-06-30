import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { UnsubscribeOutcome } from '../topics/subscription';

type ProcessUnsubscribeResult =
	| { success: false; reason: 'not_found' }
	| { success: true; alreadyUnsubscribed: true }
	| { success: true; alreadyUnsubscribed: false; listsRemoved: number };

// Internal query to get contact for unsubscribe verification
export const getContactForUnsubscribe = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return null;

		// Get instance display name from settings
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		// Check if contact is subscribed to any topics
		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect();

		const hasActiveSubscriptions = memberships.length > 0;

		return {
			_id: contact._id,
			email: contact.email,
			firstName: contact.firstName,
			lastName: contact.lastName,
			subscribed: hasActiveSubscriptions,
			organizationName: settings?.defaultFromName ?? 'Unknown',
		};
	},
});

/**
 * Public unsubscribe link entry point.
 *
 * Thin shell delegating to the Topic subscription (module)'s
 * `unsubscribeAllForContact` entry. The module owns the membership delete,
 * the topic_unsubscribed activity row, the cachedMemberCount decrement, the
 * contact.updatedAt patch, the formSubmissions.confirmedAt clear, the
 * campaigns.statsUnsubscribed increment, and the topic.unsubscribed webhook
 * fanout — all gated on `source: 'public_email_link'`.
 *
 * See docs/adr/0013-topic-subscription-module.md.
 */
export const processUnsubscribe = internalMutation({
	args: {
		contactId: v.id('contacts'),
		topicId: v.optional(v.id('topics')), // Optional: specific topic to unsubscribe from
	},
	handler: async (ctx, args): Promise<ProcessUnsubscribeResult> => {
		const { outcomes }: { outcomes: UnsubscribeOutcome[] } = await ctx.runMutation(
			internal.topics.subscription.unsubscribeAllForContact,
			{
				contactId: args.contactId,
				...(args.topicId ? { topicId: args.topicId } : {}),
				source: 'public_email_link',
				reason: 'unsubscribe',
			},
		);

		// Preserve the legacy response shape.
		// - contact_not_found maps to { success: false, reason: 'not_found' }.
		// - no memberships removed (already not a member, or empty memberships):
		//   { success: true, alreadyUnsubscribed: true }.
		// - removals happened: { success: true, alreadyUnsubscribed: false, listsRemoved }.
		for (const outcome of outcomes) {
			if (!outcome.ok && outcome.reason === 'contact_not_found') {
				return { success: false, reason: 'not_found' };
			}
		}

		const removedCount = outcomes.filter(
			(o) => o.ok && o.action === 'unsubscribed',
		).length;

		if (removedCount === 0) {
			return { success: true, alreadyUnsubscribed: true };
		}

		return {
			success: true,
			alreadyUnsubscribed: false,
			listsRemoved: removedCount,
		};
	},
});
