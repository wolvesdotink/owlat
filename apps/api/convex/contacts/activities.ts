import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import type { Doc } from '../_generated/dataModel';
import { batchGet } from '../_utils/batchLoader';
import {
	contactActivityTypeValidator,
	type ContactActivityType,
} from '../contactActivities/catalog';

/** Activity-type literal union. Re-exported for back-compat with existing callers. */
export type ActivityType = ContactActivityType;

// Writes to `contactActivities` are owned by the **Contact activity
// (module)** at `convex/contactActivities/`. Lifecycle modules (Send,
// DOI, Topic subscription) emit `contact_activity` effects that route
// through `recordContactActivity`; non-lifecycle inline writers (e.g.
// `inbox/messages.ts:receiveMessage`) call it directly. The per-type
// `logXActivity` mutations and the generic `create` mutation that used
// to live in this file were never wired up and are now deleted.

// List activities for a contact with pagination
// Returns activities in chronological order (most recent first)
export const listByContact = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
		cursor: v.optional(v.number()), // timestamp to fetch activities before
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		// Query activities for this contact, ordered by occurredAt descending
		const activitiesQuery = ctx.db
			.query('contactActivities')
			.withIndex('by_contact_and_occurred_at', (q) => {
				const baseQuery = q.eq('contactId', args.contactId);
				// If cursor provided, get activities before that timestamp
				if (args.cursor) {
					return baseQuery.lt('occurredAt', args.cursor);
				}
				return baseQuery;
			})
			.order('desc');

		const activities = await activitiesQuery.take(limit + 1);

		// Check if there are more activities
		const hasMore = activities.length > limit;
		const items = hasMore ? activities.slice(0, limit) : activities;
		const nextCursor = hasMore ? items[items.length - 1]?.occurredAt : undefined;

		return {
			items,
			nextCursor,
			hasMore,
		};
	},
});

// Get total count of activities for a contact (capped at 10,000)
export const countByContact = authedQuery({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => {
		const activities = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(10_000);
		return activities.length;
	},
});

// Get recent activities (for dashboard)
export const getRecent = authedQuery({
	args: {
		limit: v.optional(v.number()),
		activityTypes: v.optional(v.array(contactActivityTypeValidator)),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 10;

		let recentActivities;

		if (args.activityTypes && args.activityTypes.length > 0) {
			// When filtering by type, we need to over-fetch since we filter post-query
			// Take more than needed to account for filtering, then slice
			const activities = await ctx.db
				.query('contactActivities')
				.order('desc')
				.take(limit * 10);

			const allowed = new Set<ContactActivityType>(args.activityTypes);
			recentActivities = activities
				.filter((a) => allowed.has(a.activityType))
				.slice(0, limit);
		} else {
			// No type filter — efficient take
			recentActivities = await ctx.db
				.query('contactActivities')
				.order('desc')
				.take(limit);
		}

		// Batch-load all contacts at once
		const contactIds = recentActivities.map((a) => a.contactId);
		const contactsMap = await batchGet<Doc<'contacts'>>(ctx, contactIds);

		const activitiesWithContacts = recentActivities.map((activity) => {
			const contact = contactsMap.get(String(activity.contactId));
			return {
				...activity,
				// Don't surface a soft-deleted (GDPR-erased) contact's PII
				// (email/name) — treat it as an unresolved contact.
				contact: contact && contact.deletedAt === undefined
					? {
							_id: contact._id,
							email: contact.email,
							firstName: contact.firstName,
							lastName: contact.lastName,
						}
					: null,
			};
		});

		return activitiesWithContacts;
	},
});

// (Removed orphaned deleteByContact mutation — it had no caller and did an
// unbounded .collect(); contact-activity cleanup runs through the cascade in
// lib/contactMutations.ts permanentlyDeleteContactWithRelations / merge.)
