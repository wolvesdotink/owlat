import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	integrationProviderConfigValidator,
	suppressionCountsValidator,
} from '../integrationImports/_common';
import { duplicateHandlingValidator } from '../lib/literalValidators';

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
		// account's rejection blacklist.
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
		// this run. Absent on every contacts-only run. Written only by the
		// walker's per-page accumulation; the terminal hop reports it once as
		// `blocklist.provider_import_summary`.
		suppressionCounts: v.optional(suppressionCountsValidator),
		// Page identity and recovery (ADR-0027, #996/#999 amendment). A page
		// commits only while `status` is 'running' and its `cursor` and page
		// number still equal these, in the same transaction as its writes.
		// `pagesCommitted` counts commits under that rule; absent on a run a
		// previous release started (read as 0). `pageJobId` is the scheduled hop
		// that owns the current page, `pageRecoveries` how often the recovery
		// sweep has re-issued it, `lastPageAt` when the last page committed.
		pagesCommitted: v.optional(v.number()),
		pageJobId: v.optional(v.id('_scheduled_functions')),
		pageRecoveries: v.optional(v.number()),
		lastPageAt: v.optional(v.number()),
		// The run's provider config with its API key SEALED, kept while the run
		// is live so the recovery sweep can re-issue a lost page. Never written
		// with a plaintext key (absent when the instance has no INSTANCE_SECRET),
		// cleared when the run ends, and stripped from `getImportProgress`.
		resumeConfig: v.optional(integrationProviderConfigValidator),
		// Config
		handleDuplicates: duplicateHandlingValidator,
		topicId: v.optional(v.id('topics')),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
	}).index('by_status', ['status']),
};
