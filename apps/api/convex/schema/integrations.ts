import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { suppressionCountsValidator } from '../integrationImports/_common';
import { duplicateHandlingValidator } from '../lib/convexValidators';

/**
 * Integration tables — async import jobs for external providers (Mailchimp,
 * Stripe, Mandrill).
 *
 * Spread into `defineSchema()` from schema.ts via `...integrationTables`.
 */
export const integrationTables = {
	// Integration Imports - tracks progress of async integration imports
	// (Mailchimp, Stripe, Mandrill)
	integrationImports: defineTable({
		// Widening a literal union is additive: every existing row still
		// deserializes. `mandrill` runs carry no contacts at all — they import the
		// account's rejection blacklist (plan D9).
		provider: v.union(v.literal('mailchimp'), v.literal('stripe'), v.literal('mandrill')),
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
		// AGGREGATED — per-disposition tally of the suppression carry-over half of
		// this run (plan D9). Absent on every contacts-only run, including every
		// row written before P4.1. Written only by the walker's per-page
		// accumulation; the terminal hop reports it once as
		// `blocklist.provider_import_summary`.
		suppressionCounts: v.optional(suppressionCountsValidator),
		// Config
		handleDuplicates: duplicateHandlingValidator,
		topicId: v.optional(v.id('topics')),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
	}).index('by_status', ['status']),
};
