import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { memberErasurePhaseValidator } from '../auth/erasure/phaseCatalog';

/**
 * Member erasure jobs — the persisted progress of erasing one account after its
 * deletion request came due (auth/erasure/walker.ts).
 *
 * Created in the transaction that deletes the member's profile, so the subject
 * (`authUserId`) is never known only to a scheduled function's arguments. The
 * walk runs as a chain of bounded transactions; this row is where it resumes
 * after each one, after a crash or a failed attempt, and where an operator sees
 * a failure (`status`, `attempts`, `lastError`). It is deleted when the erasure
 * finishes and its end state checks out; the request row then says `completed`.
 *
 * Spread into `defineSchema()` from schema.ts via `...memberErasureTables`.
 */
export const memberErasureTables = {
	memberErasureJobs: defineTable({
		requestId: v.id('accountDeletionRequests'),
		// The BetterAuth user id whose data is erased, and the login email it had
		// when the erasure began (decided invitations and verification records are
		// keyed by the address, not the id).
		authUserId: v.string(),
		email: v.string(),
		// running  — a transaction chain is (or should be) working on it;
		// retrying — the last transaction failed and a retry is scheduled;
		// failed   — retries are exhausted; the daily sweep re-arms it.
		status: v.union(v.literal('running'), v.literal('retrying'), v.literal('failed')),
		phase: memberErasurePhaseValidator,
		// Pagination cursor inside `phase`, for the one phase that keeps the rows
		// it reads (verification records that belong to someone else).
		cursor: v.optional(v.string()),
		rowsProcessed: v.number(),
		transactions: v.number(),
		// Consecutive failed attempts; reset by the next successful transaction.
		attempts: v.number(),
		// Rows per transaction while recovering from one that hit a platform
		// limit: one after the failure, doubling with every transaction that
		// commits, absent once back at the full budget.
		rowCap: v.optional(v.number()),
		// Walks that reached the end and found the end-state check failing (a row
		// written back by a racing writer). Each one restarts the phases.
		verificationPasses: v.optional(v.number()),
		// The chain allowed to advance the job. Every (re)scheduled drive carries a
		// fresh one, so a chain the stall sweep replaced stops at its next step
		// instead of running beside its successor.
		lease: v.optional(v.string()),
		// Set while the job waits for a workspace deletion to finish sweeping.
		isWaitingForWorkspaceDeletion: v.optional(v.boolean()),
		lastError: v.optional(v.string()),
		lastErrorAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_request', ['requestId'])
		.index('by_status_and_updated_at', ['status', 'updatedAt']),
};
