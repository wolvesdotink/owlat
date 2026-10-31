/**
 * What the migration runner (`migrations/admin.ts`) decides, without a
 * database: each manifest migration's state from its ledger row, which
 * migrations to start now, and which ones hold back an update.
 *
 * States, from the ledger row (`migrationRuns`) and the page jobs:
 *   - `pending`: no ledger row; it never started on this deployment.
 *   - `running`: a running row that moved within its stall window.
 *   - `failed`: a running row whose last scheduled page failed. The error is
 *     the job's.
 *   - `interrupted`: a running row that has not moved for its stall window,
 *     with no failed page found (a cancelled chain, a lost job).
 *   - `completed`: the row's final page committed.
 * `failed` and `interrupted` resume from the recorded cursor: `run` without
 * arguments continues the pass the row describes.
 */

import { semverCompare } from '@owlat/shared/semver';

export type MigrationState = 'pending' | 'running' | 'failed' | 'interrupted' | 'completed';

/** The manifest fields the plan reads (`MigrationManifestEntry`). */
export interface PlanEntry {
	migration: string;
	introducedIn: string;
	dependsOn: readonly string[];
	isSteppingStone: boolean;
	requiredBefore?: string;
	stallAfterMs?: number;
}

/** The ledger fields the plan reads (`MigrationRun`). */
export interface PlanRun {
	status: 'running' | 'completed';
	updatedAt: number;
}

export interface DerivedState {
	state: MigrationState;
	/** When a running pass counts as stopped if it does not move again; null unless running. */
	stalledAt: number | null;
	error: string | null;
}

export function deriveMigrationState(
	entry: PlanEntry,
	run: PlanRun | null,
	options: { now: number; defaultStallAfterMs: number; failedPageError: string | null }
): DerivedState {
	if (!run) return { state: 'pending', stalledAt: null, error: null };
	if (run.status === 'completed') return { state: 'completed', stalledAt: null, error: null };
	if (options.failedPageError !== null) {
		return { state: 'failed', stalledAt: null, error: options.failedPageError };
	}
	const stalledAt = run.updatedAt + (entry.stallAfterMs ?? options.defaultStallAfterMs);
	if (options.now >= stalledAt) return { state: 'interrupted', stalledAt, error: null };
	return { state: 'running', stalledAt, error: null };
}

/** The dependencies of `entry` that have not completed yet. */
export function unfinishedDependencies(
	entry: PlanEntry,
	states: ReadonlyMap<string, MigrationState>
): string[] {
	return entry.dependsOn.filter((dependency) => states.get(dependency) !== 'completed');
}

export interface StartPlan {
	/** Start (pending) or resume (failed, interrupted) these now, in this order. */
	start: string[];
	/** Not started yet: a dependency has not completed, or a worker has not moved. */
	waiting: string[];
}

/**
 * Which migrations to start now. A migration starts once every dependency has
 * completed and no worker holds it (`heldByWorkers`: a contract step whose
 * workers have not all moved to the versions it needs); a running or
 * completed one is never started again. `failed` and `interrupted` ones are
 * resumed only when `resumeStopped` is set: an admin's explicit run does, the
 * runner's own ticks do not (they stop instead, so a page that fails every
 * time is not retried forever).
 */
export function planMigrationStarts(
	entries: readonly PlanEntry[],
	states: ReadonlyMap<string, MigrationState>,
	options: { resumeStopped: boolean; heldByWorkers?: ReadonlySet<string> }
): StartPlan {
	const start: string[] = [];
	const waiting: string[] = [];
	for (const entry of entries) {
		const state = states.get(entry.migration) ?? 'pending';
		if (state === 'completed' || state === 'running') continue;
		if (state !== 'pending' && !options.resumeStopped) continue;
		if (
			unfinishedDependencies(entry, states).length > 0 ||
			options.heldByWorkers?.has(entry.migration)
		) {
			waiting.push(entry.migration);
			continue;
		}
		start.push(entry.migration);
	}
	return { start, waiting };
}

/** The first migration that stopped (failed or interrupted), in manifest order. */
export function firstStoppedMigration(
	entries: readonly PlanEntry[],
	states: ReadonlyMap<string, MigrationState>
): string | null {
	const stopped = entries.find((entry) => {
		const state = states.get(entry.migration);
		return state === 'failed' || state === 'interrupted';
	});
	return stopped?.migration ?? null;
}

/** Whether updating to `targetVersion` needs `entry` completed first. */
export function blocksUpdateTo(entry: PlanEntry, targetVersion: string): boolean {
	if (!entry.isSteppingStone) return false;
	return entry.requiredBefore
		? semverCompare(targetVersion, entry.requiredBefore) >= 0
		: semverCompare(targetVersion, entry.introducedIn) > 0;
}

/** The stepping stones that have to complete before updating to `targetVersion`. */
export function updateBlockers(
	entries: readonly PlanEntry[],
	states: ReadonlyMap<string, MigrationState>,
	targetVersion: string
): string[] {
	return entries
		.filter(
			(entry) => states.get(entry.migration) !== 'completed' && blocksUpdateTo(entry, targetVersion)
		)
		.map((entry) => entry.migration);
}

/**
 * The error of the job a running pass waits on (its row's `pageJob`), or null
 * while that job is pending, running or done. A job recorded for an older
 * generation says nothing about the current pass.
 */
export function pageJobError(
	run: { generation: number; pageJob?: { generation: number } },
	job: { state: { kind: string; error?: string } } | null
): string | null {
	if (!job || run.pageJob?.generation !== run.generation) return null;
	if (job.state.kind !== 'failed') return null;
	return job.state.error || 'The page failed without an error message';
}
