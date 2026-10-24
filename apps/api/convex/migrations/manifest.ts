/**
 * The migration manifest (CONVENTIONS.md, "Migration manifest"): every data
 * migration this release can run from Settings → System & updates, with the
 * release that introduced it, what it waits for, and whether a later release's
 * contract depends on it.
 *
 * The ledger (`migrationRuns`, lib/migrationLedger.ts) records the migrations
 * that have started; only this list knows the ones that never did. The admin
 * runner (`migrations/admin.ts`) reads both: a manifest entry without a ledger
 * row is pending, wherever the deployment was updated from. That is how a
 * deployment that skipped releases still sees their unfinished migrations.
 *
 * Every entry is a ledger-backed migration whose `run` entry point starts a
 * pass, resumes an unfinished one from its recorded cursor, and leaves a
 * completed one alone when called without arguments. The runner calls `run`
 * exactly that way, so nothing here restarts a finished migration.
 *
 * Not listed:
 *   - 0035 to 0052 predate the ledger: nothing records whether they ran, so
 *     they stay CLI-only (the maintenance guide lists them).
 *   - Retired ledger migrations, below: a later release already removed what
 *     they convert, so its deploy proved them done.
 *
 * Adding a migration: add its entry in the PR that adds the module, with the
 * module's `INTRODUCED_IN`. `__tests__/manifest.test.ts` fails on a ledger
 * migration that is neither listed nor retired.
 */

import type { FunctionReference } from 'convex/server';
import { internal } from '../_generated/api';
import type { WorkerRequirement } from '../maintenance/workerRegistry';

export interface MigrationManifestEntry {
	/** The module under `migrations/`, and its ledger row's `migration`. */
	migration: string;
	/** The release that introduced it (the module's `INTRODUCED_IN`). */
	introducedIn: string;
	/** Migrations that must complete before this one starts. Listed earlier in the manifest. */
	dependsOn: readonly string[];
	/**
	 * A later release's contract depends on it, so it must complete before the
	 * deployment updates to that release. The in-app update refuses until it
	 * has (`updateBlockers`).
	 */
	isSteppingStone: boolean;
	/**
	 * The first release whose deploy needs a stepping stone completed. Absent:
	 * any release after `introducedIn`.
	 */
	requiredBefore?: string;
	/**
	 * A contract step: it removes or rewrites what workers below these wire
	 * versions still read or write. Nothing starts or resumes it until every
	 * worker of each service has moved (`readWorkerWaits` in
	 * `maintenance/workerRegistry.ts`): the runner holds it, and its `run`
	 * throws (`beginMigrationRun` in `lib/migrationLedger.ts`).
	 */
	requiresWorkers?: WorkerRequirement;
	/** A cron starts and resumes it without an operator; the runner only starts it sooner. */
	startsItself?: boolean;
	/**
	 * A running pass whose ledger row has not moved for this long has stopped
	 * (its page chain died). Defaults to {@link DEFAULT_STALL_AFTER_MS}.
	 */
	stallAfterMs?: number;
	/** The entry point: starts, or resumes, the pass. Called with no arguments. */
	run: FunctionReference<'mutation', 'internal'>;
}

/**
 * A page chain schedules its next page as it commits the last one, so a
 * running pass moves its ledger row every few seconds. Fifteen minutes without
 * a move means the chain is gone, not slow.
 */
export const DEFAULT_STALL_AFTER_MS = 15 * 60_000;

/**
 * Ledger migrations a later release made moot: its schema dropped what they
 * convert, so its deploy could only succeed once they had nothing left to do.
 */
export const RETIRED_MIGRATIONS: readonly string[] = [
	// 0.6.11 removed `attribution` from the schema.
	'0066_backfill_clarification_origin',
];

/** In dependency order: an entry's `dependsOn` are all listed before it. */
export const MIGRATION_MANIFEST: readonly MigrationManifestEntry[] = [
	{
		migration: '0053_project_open_commitments',
		introducedIn: '0.6.6',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0053_project_open_commitments'].run,
	},
	{
		migration: '0054_backfill_folder_membership',
		introducedIn: '0.6.7',
		dependsOn: [],
		isSteppingStone: false,
		startsItself: true,
		// Its cron resumes a pass still for an hour, and checks every 10 minutes;
		// while it waits for its folder walks, `finish` does not move the row.
		stallAfterMs: 75 * 60_000,
		run: internal.migrations['0054_backfill_folder_membership'].run,
	},
	{
		migration: '0055_repair_repeated_block_ids',
		introducedIn: '0.6.7',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0055_repair_repeated_block_ids'].run,
	},
	{
		migration: '0056_retry_parked_mail_accounts',
		introducedIn: '0.6.7',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0056_retry_parked_mail_accounts'].run,
	},
	{
		migration: '0057_withdraw_opted_out_confirmation_tokens',
		introducedIn: '0.6.7',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0057_withdraw_opted_out_confirmation_tokens'].run,
	},
	{
		migration: '0060_saved_reply_scopes',
		introducedIn: '0.6.8',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0060_saved_reply_scopes'].run,
	},
	{
		migration: '0064_backfill_send_time_profiles',
		introducedIn: '0.6.8',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0064_backfill_send_time_profiles'].run,
	},
	{
		migration: '0065_backfill_thread_response_metrics',
		introducedIn: '0.6.8',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0065_backfill_thread_response_metrics'].run,
	},
	{
		migration: '0067_empty_retired_summaries',
		introducedIn: '0.6.12',
		dependsOn: [],
		// The next release drops both summary tables and `summaryCache`.
		isSteppingStone: true,
		run: internal.migrations['0067_empty_retired_summaries'].run,
	},
	{
		migration: '0068_seal_fact_keys',
		introducedIn: '0.6.12',
		dependsOn: [],
		// The next release drops `threadFacts.factKey`.
		isSteppingStone: true,
		run: internal.migrations['0068_seal_fact_keys'].run,
	},
	{
		migration: '0069_restrict_captured_file_knowledge',
		introducedIn: '0.6.13',
		dependsOn: [],
		isSteppingStone: false,
		run: internal.migrations['0069_restrict_captured_file_knowledge'].run,
	},
];
