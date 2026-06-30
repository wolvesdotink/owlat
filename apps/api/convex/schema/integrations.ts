import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Integration tables — async import jobs for external providers (Mailchimp, Stripe).
 *
 * Spread into `defineSchema()` from schema.ts via `...integrationTables`.
 */
export const integrationTables = {
	// Integration Imports - tracks progress of async integration imports (Mailchimp, Stripe)
	integrationImports: defineTable({
		provider: v.union(v.literal('mailchimp'), v.literal('stripe')),
		status: v.union(v.literal('running'), v.literal('completed'), v.literal('failed')),
		// Pagination state
		cursor: v.string(), // Mailchimp: offset as string, Stripe: starting_after or ""
		// Accumulated results
		imported: v.number(),
		updated: v.number(),
		skipped: v.number(),
		failed: v.number(),
		errors: v.array(v.string()),
		totalEstimate: v.optional(v.number()),
		// Config
		handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
		topicId: v.optional(v.id('topics')),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index('by_status', ['status']),
};
