import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';

// Internal query to get contact preferences for the preference center
export const getContactPreferences = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return null;

		// Get instance display name from settings
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		// Get all topics
		const topics = await ctx.db
			.query('topics')
			.collect();

		// Get the contact's topic memberships
		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect();

		const subscribedTopicIds = new Set(memberships.map((m) => m.topicId));

		// Map topics with subscription status
		const topicsWithStatus = topics.map((topic) => ({
			_id: topic._id,
			name: topic.name,
			description: topic.description,
			subscribed: subscribedTopicIds.has(topic._id),
		}));

		return {
			_id: contact._id,
			email: contact.email,
			firstName: contact.firstName,
			lastName: contact.lastName,
			teamName: settings?.defaultFromName ?? 'Unknown',
			topics: topicsWithStatus,
		};
	},
});

/**
 * Apply a batch of topic-subscription toggles for a Contact from the
 * preference center. Each toggle routes through the Topic subscription
 * (module):
 *   - Subscribe: `skipDoi: true` because the contact is authenticated via
 *     the preference-center link and is actively opting in (legacy comment:
 *     "user is actively opting in via preference center so no DOI required
 *     for this action").
 *   - Unsubscribe: `source: 'preferences_page'` — the module's source→effects
 *     map fires the `topic.unsubscribed` Webhook event and clears form-
 *     submission confirmations so a future resubscribe re-runs DOI.
 *
 * `globalUnsubscribe: true` removes the Contact from every Topic in one
 * action via `unsubscribeAllForContact` (same module entry the public
 * unsubscribe link uses), then ignores any `topicUpdates` for the call —
 * a one-click "unsubscribe from everything" can't be partially overridden
 * by a stale per-topic toggle in the same payload.
 *
 * See docs/adr/0013-topic-subscription-module.md.
 */
export const updateContactPreferences = internalMutation({
	args: {
		contactId: v.id('contacts'),
		globalUnsubscribe: v.optional(v.boolean()),
		topicUpdates: v.optional(
			v.array(
				v.object({
					topicId: v.id('topics'),
					subscribed: v.boolean(),
				})
			)
		),
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			return { success: false, reason: 'not_found' };
		}

		if (args.globalUnsubscribe) {
			await ctx.runMutation(internal.topics.subscription.unsubscribeAllForContact, {
				contactId: args.contactId,
				source: 'preferences_page',
				reason: 'unsubscribe',
			});
			return { success: true };
		}

		if (args.topicUpdates) {
			for (const update of args.topicUpdates) {
				if (update.subscribed) {
					await ctx.runMutation(
						internal.topics.subscription.subscribe,
						{
							topicId: update.topicId,
							contactId: args.contactId,
							source: 'preferences_page',
							skipDoi: true,
						},
					);
				} else {
					await ctx.runMutation(
						internal.topics.subscription.unsubscribe,
						{
							topicId: update.topicId,
							contactId: args.contactId,
							source: 'preferences_page',
						},
					);
				}
			}
		}

		return { success: true };
	},
});
