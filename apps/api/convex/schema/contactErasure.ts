import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { contactErasurePhaseValidator } from '../contacts/erasure/phaseCatalog';

/**
 * Contact erasure jobs — the persisted progress of permanently deleting one
 * contact and everything that hangs off it (contacts/erasure/walker.ts).
 *
 * A contact's history has no fixed size, so the erasure runs as a sequence of
 * bounded transactions. This row is where the walk resumes from after each one,
 * after a crash, or after a failed attempt, and where an operator sees a
 * failure: `status`, `attempts` and `lastError`. It is deleted in the same
 * transaction as the contact row, so a finished erasure leaves nothing behind.
 *
 * Spread into `defineSchema()` from schema.ts via `...contactErasureTables`.
 */
export const contactErasureTables = {
	contactErasureJobs: defineTable({
		contactId: v.id('contacts'),
		// What asked for the erasure: the soft-delete retention window running
		// out, or a hard delete through the REST API.
		reason: v.union(v.literal('retention'), v.literal('api_delete')),
		// running  — a transaction chain is (or should be) working on it;
		// retrying — the last transaction failed and a retry is scheduled;
		// failed   — retries are exhausted; the daily sweep re-arms it.
		status: v.union(v.literal('running'), v.literal('retrying'), v.literal('failed')),
		phase: contactErasurePhaseValidator,
		// Pagination cursor inside `phase`, for the phases that keep their rows
		// (scrubbed sends) and so cannot resume by re-reading from the start.
		cursor: v.optional(v.string()),
		rowsProcessed: v.number(),
		transactions: v.number(),
		// Consecutive failed attempts; reset by the next successful transaction.
		attempts: v.number(),
		lastError: v.optional(v.string()),
		lastErrorAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_contact', ['contactId'])
		.index('by_status_and_updated_at', ['status', 'updatedAt']),
};
