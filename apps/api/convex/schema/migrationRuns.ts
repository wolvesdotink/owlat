import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The migration ledger: one row per data migration (CONVENTIONS.md, "Durable
 * progress and completion"). A paged migration writes its row in the same
 * transaction as each page, so the row is the deployment's own record of how
 * far the migration got and whether it finished. A contract step or a
 * stepping-stone check reads `status` and `completedAt` here instead of
 * trusting a log line. Written through `lib/migrationLedger.ts`.
 */
export const migrationRunTables = {
	migrationRuns: defineTable({
		/** The module under `migrations/`, e.g. `0053_project_open_commitments`. */
		migration: v.string(),
		/** The release that introduced the migration, e.g. `0.6.6`. */
		introducedIn: v.string(),
		status: v.union(v.literal('running'), v.literal('completed')),
		/**
		 * Bumped by every start, resume and restart. A page carries the
		 * generation it was scheduled under and does nothing once a newer one
		 * exists, so at most one page chain moves the row.
		 */
		generation: v.number(),
		/** Pagination cursor after the last committed page; absent before the first. */
		cursor: v.optional(v.string()),
		pageCount: v.number(),
		/** Rows the pass has read, and rows it changed. */
		scannedCount: v.number(),
		changedCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
	}).index('by_migration', ['migration']),
};
