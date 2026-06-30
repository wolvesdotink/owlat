import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Topic tables — content categories for subscriber preferences + contact membership.
 *
 * DOI status lives on the `contacts` table, not here.
 *
 * Spread into `defineSchema()` from schema.ts via `...topicTables`.
 */
export const topicTables = {
	// Topics - content categories for subscriber preferences (e.g., "Product Updates", "Promotions")
	topics: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		displayOrder: v.optional(v.number()), // For preference center ordering
		isDefault: v.optional(v.boolean()), // Auto-subscribe new contacts
		requireDoubleOptIn: v.optional(v.boolean()),
		cachedMemberCount: v.optional(v.number()),
		// Last time cachedMemberCount was recomputed; parity with segments.cachedCountUpdatedAt.
		cachedCountUpdatedAt: v.optional(v.number()),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		// Values: 'demo' (seeded) | 'dev-forced' (created via dev shortcut).
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.optional(v.number()),
	}),

	// Contact Topics - junction table for many-to-many relation
	// DOI is tracked at the contact level (contacts.doiStatus), not here
	contactTopics: defineTable({
		contactId: v.id('contacts'),
		topicId: v.id('topics'),
		addedAt: v.number(),
		seedTag: v.optional(v.string()),
		// Set when a form forced double-opt-in on a topic that does NOT itself
		// require DOI, so the confirm-time fanout (which otherwise keys off
		// topic.requireDoubleOptIn) still fires this membership's topic_subscribed
		// trigger + topic_confirmed activity. Cleared once that fanout runs.
		pendingDoiConfirmation: v.optional(v.boolean()),
	})
		.index('by_contact', ['contactId'])
		.index('by_topic', ['topicId'])
		.index('by_contact_and_topic', ['contactId', 'topicId']),
};
