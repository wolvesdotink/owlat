import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import type { ContactActivityType } from '../contactActivities/catalog';

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

// (Removed orphaned deleteByContact mutation — it had no caller and did an
// unbounded .collect(); contact-activity cleanup runs through the cascade in
// lib/contactMutations.ts permanentlyDeleteContactWithRelations / merge.)
