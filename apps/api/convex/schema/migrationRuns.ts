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
		/**
		 * Which kind of pass this is, for a migration with more than one (0054's
		 * `rebuild`); absent for the ordinary pass. Set when a pass starts and
		 * kept by a resume, so resuming never turns a pass into another kind.
		 */
		mode: v.optional(v.string()),
		pageCount: v.number(),
		/** Rows the pass has read, and rows it changed. */
		scannedCount: v.number(),
		changedCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
		/**
		 * The job the pass waits on: the next page (or poll) its chain scheduled,
		 * with the generation it belongs to. Written by `scheduleMigrationPage`
		 * without moving `updatedAt`, so a failed job is found by id however long
		 * after the last committed page it ran. Absent on a row written before
		 * this field existed, until its next scheduled page.
		 */
		pageJob: v.optional(v.object({ id: v.id('_scheduled_functions'), generation: v.number() })),
		/**
		 * A failure the pass recorded itself (`recordMigrationFailure`): work it
		 * started outside its own page chain kept failing, so it stopped. The row
		 * stays `running`; the next start or resume clears this.
		 */
		failure: v.optional(v.object({ error: v.string(), at: v.number() })),
		/**
		 * Bumped by an operator's explicit start or retry, never by a cron's
		 * automatic resume. A pass that counts failures across resumes (0054's
		 * folder walks) keys its streaks to it, so only a person resets them.
		 */
		retryEpoch: v.optional(v.number()),
	}).index('by_migration', ['migration']),

	/**
	 * The migration runner behind Settings → System & updates
	 * (`migrations/admin.ts`): at most one row. While `active`, a tick every
	 * few seconds starts each manifest migration whose dependencies have
	 * completed, until every one has completed (`finished`) or one failed or
	 * stopped moving (`stopped`). It only starts and resumes migrations through
	 * their own `run` entry points; their progress stays on their
	 * `migrationRuns` rows.
	 */
	migrationDriver: defineTable({
		status: v.union(v.literal('active'), v.literal('finished'), v.literal('stopped')),
		/** Bumped by every start; a tick scheduled under an older one does nothing. */
		generation: v.number(),
		/** The platform admin who started the runner (auth user id). */
		startedBy: v.string(),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		/** Set with `stopped`: the migration that stopped the runner, and why. */
		stoppedMigration: v.optional(v.string()),
		stoppedError: v.optional(v.string()),
	}),
};
