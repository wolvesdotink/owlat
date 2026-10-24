/**
 * Data migrations from Settings → System & updates (#1345).
 *
 * The page lists every migration in the manifest (`migrations/manifest.ts`)
 * with its state, read from the migration ledger (`migrationRuns`,
 * lib/migrationLedger.ts), and runs the pending ones. A migration that
 * started from the CLI, from its cron or on another release reads the same,
 * since only the ledger records progress.
 *
 * THE RUNNER
 * ----------
 * `runPending` starts each migration whose dependencies have completed by
 * calling its own `run` entry point, in this transaction, the way
 * `npx convex run migrations/NNNN_name:run` does: a pending migration starts,
 * an interrupted or failed one resumes from its recorded cursor, and a
 * completed or running one is not called at all. The pages then run in the
 * background as each migration's own chain.
 *
 * A migration waiting on a dependency needs someone to start it once the
 * dependency completes, so `runPending` also opens the runner row
 * (`migrationDriver`) and schedules {@link advance}, which repeats that step
 * every {@link TICK_MS} until every migration has completed (`finished`) or
 * one has failed or stopped moving (`stopped`; the admin resumes it with the
 * next run). Both run in one serializable transaction over the ledger rows and
 * the runner row, so two admins clicking at once cannot start a migration
 * twice: the second sees the first's ledger rows, and an active runner.
 *
 * Gating: platform admins only, like the rest of System & updates. `advance`
 * and `supportBundleState` (the support bundle's read, with the admin key) are
 * internal.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { platformAdminMutation, platformAdminQuery } from '../lib/authedFunctions';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { readMigrationRun, type MigrationRun } from '../lib/migrationLedger';
import {
	deriveMigrationState,
	firstStoppedMigration,
	pageJobError,
	planMigrationStarts,
	unfinishedDependencies,
	updateBlockers as stepBlockers,
	type DerivedState,
	type MigrationState,
} from '../lib/migrationPlan';
import { logInfo, logWarn } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { throwInvalidInput } from '../_utils/errors';
import { isValidTargetVersion } from '@owlat/shared/releaseArtifacts';
import { DEFAULT_STALL_AFTER_MS, MIGRATION_MANIFEST } from './manifest';

/** How often an active runner checks for migrations it can start. */
const TICK_MS = 30_000;

/**
 * An active runner whose row has not moved for this long lost its tick chain;
 * the next run takes it over instead of reporting it as busy.
 */
const RUNNER_STALE_MS = 4 * TICK_MS;

type Ctx = { db: QueryCtx['db'] };

interface ManifestState {
	run: MigrationRun | null;
	derived: DerivedState;
}

/** The error of the job a running pass waits on, read by the id its chain recorded. */
async function readFailedPage(ctx: Ctx, run: MigrationRun): Promise<string | null> {
	// A failure the pass recorded itself (0054's folder walks) comes first.
	if (run.failure) return run.failure.error;
	if (!run.pageJob) return null;
	return pageJobError(run, await ctx.db.system.get(run.pageJob.id));
}

/** Every manifest migration's ledger row and state, by migration. */
async function readManifestStates(ctx: Ctx, now: number): Promise<Map<string, ManifestState>> {
	const states = new Map<string, ManifestState>();
	for (const entry of MIGRATION_MANIFEST) {
		const run = await readMigrationRun(ctx, entry.migration);
		const failedPage = run?.status === 'running' ? await readFailedPage(ctx, run) : null;
		states.set(entry.migration, {
			run,
			derived: deriveMigrationState(entry, run, {
				now,
				defaultStallAfterMs: DEFAULT_STALL_AFTER_MS,
				failedPageError: failedPage,
			}),
		});
	}
	return states;
}

function stateMap(states: Map<string, ManifestState>): Map<string, MigrationState> {
	return new Map([...states].map(([migration, { derived }]) => [migration, derived.state]));
}

async function readRunner(ctx: Ctx): Promise<Doc<'migrationDriver'> | null> {
	// A single row: `runPending` patches the one it finds.
	return await ctx.db.query('migrationDriver').first();
}

/**
 * Call `run` on each migration of `start`, in order. Returns the one whose
 * `run` threw, with its error: its writes are rolled back (`runMutation` is a
 * sub-transaction), the ones before it stay started, the ones after it are
 * not called.
 */
async function startMigrations(
	ctx: MutationCtx,
	start: readonly string[]
): Promise<{ started: string[]; failure: { migration: string; error: string } | null }> {
	const started: string[] = [];
	for (const migration of start) {
		const entry = MIGRATION_MANIFEST.find((candidate) => candidate.migration === migration);
		if (!entry) continue;
		try {
			await ctx.runMutation(entry.run, {});
			started.push(migration);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn('migration.admin.start_failed', { migration, error: message });
			return { started, failure: { migration, error: message } };
		}
	}
	return { started, failure: null };
}

async function stopRunner(
	ctx: MutationCtx,
	runner: Doc<'migrationDriver'>,
	failure: { migration: string; error: string },
	now: number
) {
	await ctx.db.patch(runner._id, {
		status: 'stopped',
		updatedAt: now,
		finishedAt: now,
		stoppedMigration: failure.migration,
		stoppedError: failure.error,
	});
}

/** The error a stopped migration reports, for the runner row. */
function stoppedError(state: ManifestState | undefined): string {
	if (state?.derived.state === 'failed' && state.derived.error) return state.derived.error;
	return 'The migration stopped making progress';
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every manifest migration with its state and progress, and the runner. The
 * state is computed at read time; `stalledAt` lets the page move a running
 * migration to interrupted when it stops moving while the page is open.
 */
export const list = platformAdminQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const states = await readManifestStates(ctx, now);
		const byMigration = stateMap(states);
		const runner = await readRunner(ctx);
		return {
			migrations: MIGRATION_MANIFEST.map((entry) => {
				const { run, derived } = states.get(entry.migration)!;
				return {
					migration: entry.migration,
					introducedIn: entry.introducedIn,
					dependsOn: [...entry.dependsOn],
					waitingFor: unfinishedDependencies(entry, byMigration),
					isSteppingStone: entry.isSteppingStone,
					requiredBefore: entry.requiredBefore ?? null,
					startsItself: entry.startsItself === true,
					// The pass stopped itself on a failure: a cron that starts it (0054's
					// ensure) leaves it alone until someone runs it again.
					hasRecordedFailure: run?.status === 'running' && run.failure !== undefined,
					state: derived.state,
					stalledAt: derived.stalledAt,
					error: derived.error,
					progress: run
						? {
								startedAt: run.startedAt,
								updatedAt: run.updatedAt,
								completedAt: run.completedAt ?? null,
								pageCount: run.pageCount,
								scannedCount: run.scannedCount,
								changedCount: run.changedCount,
							}
						: null,
				};
			}),
			runner: runner
				? {
						status: runner.status,
						startedAt: runner.startedAt,
						updatedAt: runner.updatedAt,
						finishedAt: runner.finishedAt ?? null,
						stoppedMigration: runner.stoppedMigration ?? null,
						stoppedError: runner.stoppedError ?? null,
					}
				: null,
		};
	},
});

/**
 * The stepping stones that must complete before this deployment updates to
 * `targetVersion` (CONVENTIONS.md, "Upgrade window"). The in-app update route
 * refuses while this is not empty, and the page explains it.
 */
export const updateBlockers = platformAdminQuery({
	args: { targetVersion: v.string() },
	handler: async (ctx, args) => {
		if (!isValidTargetVersion(args.targetVersion)) {
			throwInvalidInput('Invalid targetVersion (expected semver like 1.2.3)');
		}
		const states = await readManifestStates(ctx, Date.now());
		const blockers = stepBlockers(MIGRATION_MANIFEST, stateMap(states), args.targetVersion);
		return blockers.map((migration) => {
			const entry = MIGRATION_MANIFEST.find((candidate) => candidate.migration === migration)!;
			return {
				migration,
				introducedIn: entry.introducedIn,
				requiredBefore: entry.requiredBefore ?? null,
				state: states.get(migration)!.derived.state,
			};
		});
	},
});

/**
 * The ledger as `owlat support-bundle` exports it: run with the deployment's
 * admin key (`convex run migrations/admin:supportBundleState`), so it is
 * internal. The bundle leaves the operator's box, so it carries states, counts
 * and timestamps only: no cursor, no auth user id and no error text (an error
 * can quote a document), just whether there is one.
 */
export const supportBundleState = internalQuery({
	args: {},
	handler: async (ctx) => {
		const states = await readManifestStates(ctx, Date.now());
		const runner = await readRunner(ctx);
		return {
			deployedVersion: getOptional('OWLAT_VERSION') || null,
			migrations: MIGRATION_MANIFEST.map((entry) => {
				const { run, derived } = states.get(entry.migration)!;
				return {
					migration: entry.migration,
					introducedIn: entry.introducedIn,
					state: derived.state,
					stalledAt: derived.stalledAt,
					hasError: derived.error !== null,
					startedAt: run?.startedAt ?? null,
					updatedAt: run?.updatedAt ?? null,
					completedAt: run?.completedAt ?? null,
					pageCount: run?.pageCount ?? null,
					scannedCount: run?.scannedCount ?? null,
					changedCount: run?.changedCount ?? null,
				};
			}),
			runner: runner
				? {
						status: runner.status,
						startedAt: runner.startedAt,
						updatedAt: runner.updatedAt,
						finishedAt: runner.finishedAt ?? null,
						stoppedMigration: runner.stoppedMigration ?? null,
						hasStoppedError: runner.stoppedError !== undefined,
					}
				: null,
		};
	},
});

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * Start every pending migration whose dependencies have completed, resume the
 * failed and interrupted ones, and leave the runner to start the rest as their
 * dependencies complete. Completed and running migrations are not touched.
 *
 * `started` lists the migrations whose background pass this call started or
 * resumed: started, not finished. `alreadyRunning` means an active runner
 * holds the run (another admin, or an earlier click).
 */
export const runPending = platformAdminMutation({
	args: {},
	handler: async (ctx, _args, admin) => {
		const now = Date.now();
		const runner = await readRunner(ctx);
		if (runner?.status === 'active' && now - runner.updatedAt < RUNNER_STALE_MS) {
			return { outcome: 'alreadyRunning' as const, started: [], waiting: [] };
		}

		const states = await readManifestStates(ctx, now);
		const plan = planMigrationStarts(MIGRATION_MANIFEST, stateMap(states), {
			resumeStopped: true,
		});
		if (plan.start.length === 0 && plan.waiting.length === 0) {
			return { outcome: 'nothingToRun' as const, started: [], waiting: [] };
		}

		const fields = {
			status: 'active' as const,
			generation: (runner?.generation ?? 0) + 1,
			startedBy: admin.authUserId,
			startedAt: now,
			updatedAt: now,
			finishedAt: undefined,
			stoppedMigration: undefined,
			stoppedError: undefined,
		};
		const runnerId = runner
			? (await ctx.db.patch(runner._id, fields), runner._id)
			: await ctx.db.insert('migrationDriver', fields);
		const opened = (await ctx.db.get(runnerId))!;

		const { started, failure } = await startMigrations(ctx, plan.start);
		logInfo('migration.admin.run', {
			startedBy: admin.authUserId,
			started,
			waiting: plan.waiting,
			failed: failure?.migration ?? null,
		});
		if (failure) {
			await stopRunner(ctx, opened, failure, now);
			return {
				outcome: 'failed' as const,
				started,
				waiting: plan.waiting,
				failedMigration: failure.migration,
				error: failure.error,
			};
		}
		await ctx.scheduler.runAfter(TICK_MS, internal.migrations.admin.advance, {
			generation: opened.generation,
		});
		return { outcome: 'started' as const, started, waiting: plan.waiting };
	},
});

/**
 * One runner tick: stop on a failed or interrupted migration, start the ones
 * whose dependencies have completed since, and finish once every migration
 * has completed. A tick of an older generation does nothing.
 */
export const advance = internalMutation({
	args: { generation: v.number() },
	handler: async (ctx, args) => {
		const runner = await readRunner(ctx);
		if (!runner || runner.status !== 'active' || runner.generation !== args.generation) {
			return { outcome: 'superseded' as const };
		}
		const now = Date.now();
		const states = await readManifestStates(ctx, now);
		const byMigration = stateMap(states);

		const stopped = firstStoppedMigration(MIGRATION_MANIFEST, byMigration);
		if (stopped) {
			const error = stoppedError(states.get(stopped));
			await stopRunner(ctx, runner, { migration: stopped, error }, now);
			logWarn('migration.admin.stopped', { migration: stopped, error });
			return { outcome: 'stopped' as const };
		}

		const plan = planMigrationStarts(MIGRATION_MANIFEST, byMigration, { resumeStopped: false });
		const { started, failure } = await startMigrations(ctx, plan.start);
		if (failure) {
			await stopRunner(ctx, runner, failure, now);
			return { outcome: 'stopped' as const };
		}

		const isEverythingCompleted = MIGRATION_MANIFEST.every(
			(entry) => byMigration.get(entry.migration) === 'completed'
		);
		if (isEverythingCompleted) {
			await ctx.db.patch(runner._id, { status: 'finished', updatedAt: now, finishedAt: now });
			logInfo('migration.admin.finished', { generation: runner.generation });
			return { outcome: 'finished' as const };
		}

		await ctx.db.patch(runner._id, { updatedAt: now });
		await ctx.scheduler.runAfter(TICK_MS, internal.migrations.admin.advance, {
			generation: runner.generation,
		});
		if (started.length > 0) logInfo('migration.admin.started', { started });
		return { outcome: 'active' as const };
	},
});
