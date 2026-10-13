/**
 * The "Data migrations" card on Settings → System & updates
 * (components/system/MigrationsCard.vue): how a row from
 * `migrations/admin:list` reads at a given moment.
 *
 * The backend computes each state when the query runs, and a query does not
 * run again just because time passes. So a running migration carries
 * `stalledAt`, and the card moves it to interrupted itself once that moment
 * passes without a new answer.
 */

export type MigrationServerState = 'pending' | 'running' | 'failed' | 'interrupted' | 'completed';

/** The backend's states plus `waiting`: pending until a dependency completes. */
export type MigrationDisplayState = MigrationServerState | 'waiting';

export interface MigrationRow {
	migration: string;
	introducedIn: string;
	waitingFor: string[];
	isSteppingStone: boolean;
	requiredBefore: string | null;
	startsItself: boolean;
	state: MigrationServerState;
	stalledAt: number | null;
	error: string | null;
	progress: {
		startedAt: number;
		updatedAt: number;
		completedAt: number | null;
		pageCount: number;
		scannedCount: number;
		changedCount: number;
	} | null;
}

export interface MigrationRunner {
	status: 'active' | 'finished' | 'stopped';
	updatedAt: number;
}

/**
 * An active runner ticks every 30 s; one that has not for this long lost its
 * tick chain, and the backend lets the next run take it over (RUNNER_STALE_MS
 * in apps/api/convex/migrations/admin.ts).
 */
export const RUNNER_STALE_MS = 120_000;

export function displayState(row: MigrationRow, now: number): MigrationDisplayState {
	if (row.state === 'running' && row.stalledAt !== null && now >= row.stalledAt) {
		return 'interrupted';
	}
	if (row.state === 'pending' && row.waitingFor.length > 0) return 'waiting';
	return row.state;
}

/** Whether the run action has something to do for this row. */
export function isRunnable(state: MigrationDisplayState): boolean {
	return (
		state === 'pending' || state === 'waiting' || state === 'failed' || state === 'interrupted'
	);
}

/** A runner still starting migrations; while it is, the run action waits. */
export function isRunnerActive(runner: MigrationRunner | null, now: number): boolean {
	return runner?.status === 'active' && now - runner.updatedAt < RUNNER_STALE_MS;
}

export type MigrationCounts = Record<MigrationDisplayState, number>;

export function countByState(rows: readonly MigrationRow[], now: number): MigrationCounts {
	const counts: MigrationCounts = {
		pending: 0,
		waiting: 0,
		running: 0,
		failed: 0,
		interrupted: 0,
		completed: 0,
	};
	for (const row of rows) counts[displayState(row, now)] += 1;
	return counts;
}

/** Rows grouped by the release that introduced them, newest release first. */
export function groupByRelease(
	rows: readonly MigrationRow[],
	compare: (a: string, b: string) => number
): { version: string; rows: MigrationRow[] }[] {
	const groups = new Map<string, MigrationRow[]>();
	for (const row of rows) {
		const group = groups.get(row.introducedIn) ?? [];
		group.push(row);
		groups.set(row.introducedIn, group);
	}
	return [...groups]
		.sort(([a], [b]) => compare(b, a))
		.map(([version, grouped]) => ({ version, rows: grouped }));
}

/**
 * The locale key of a migration's name: `m` and its number
 * (`0053_project_open_commitments` → `m0053`).
 */
export function migrationNameKey(migration: string): string {
	return `m${migration.slice(0, 4)}`;
}
