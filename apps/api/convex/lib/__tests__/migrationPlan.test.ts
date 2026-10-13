/**
 * The migration runner's decisions (lib/migrationPlan.ts): state from the
 * ledger row and the page jobs, what starts in which order, and which
 * stepping stones hold back an update.
 */

import { describe, expect, it } from 'vitest';
import {
	blocksUpdateTo,
	deriveMigrationState,
	failedPageError,
	firstStoppedMigration,
	planMigrationStarts,
	updateBlockers,
	type MigrationState,
	type PlanEntry,
} from '../migrationPlan';

const STALL = 15 * 60_000;

function entry(migration: string, overrides: Partial<PlanEntry> = {}): PlanEntry {
	return {
		migration,
		introducedIn: '0.6.8',
		dependsOn: [],
		isSteppingStone: false,
		...overrides,
	};
}

function states(pairs: Record<string, MigrationState>): Map<string, MigrationState> {
	return new Map(Object.entries(pairs));
}

describe('deriveMigrationState', () => {
	const now = 10 * STALL;
	const options = { now, defaultStallAfterMs: STALL, failedPageError: null };

	it('reads a migration without a ledger row as pending', () => {
		expect(deriveMigrationState(entry('a'), null, options).state).toBe('pending');
	});

	it('reads a completed row as completed, whatever its age', () => {
		const run = { status: 'completed' as const, updatedAt: 0 };
		expect(deriveMigrationState(entry('a'), run, options).state).toBe('completed');
	});

	it('reads a row that moved within the stall window as running', () => {
		const run = { status: 'running' as const, updatedAt: now - 1_000 };
		expect(deriveMigrationState(entry('a'), run, options)).toEqual({
			state: 'running',
			stalledAt: now - 1_000 + STALL,
			error: null,
		});
	});

	it('reads a row that has not moved for the stall window as interrupted', () => {
		const run = { status: 'running' as const, updatedAt: now - STALL };
		expect(deriveMigrationState(entry('a'), run, options).state).toBe('interrupted');
	});

	it("honours a migration's own stall window", () => {
		const run = { status: 'running' as const, updatedAt: now - STALL };
		const slow = entry('a', { stallAfterMs: 2 * STALL });
		expect(deriveMigrationState(slow, run, options).state).toBe('running');
	});

	it('reports a failed page at once, with its error', () => {
		const run = { status: 'running' as const, updatedAt: now - 1_000 };
		expect(
			deriveMigrationState(entry('a'), run, { ...options, failedPageError: 'Unmapped row k1' })
		).toEqual({ state: 'failed', stalledAt: null, error: 'Unmapped row k1' });
	});
});

describe('planMigrationStarts', () => {
	const entries = [entry('a'), entry('b', { dependsOn: ['a'] }), entry('c')];

	it('starts the independent ones and holds a dependent until its dependency completes', () => {
		const plan = planMigrationStarts(entries, states({}), { resumeStopped: true });
		expect(plan).toEqual({ start: ['a', 'c'], waiting: ['b'] });
	});

	it('starts the dependent once the dependency has completed', () => {
		const plan = planMigrationStarts(entries, states({ a: 'completed', c: 'running' }), {
			resumeStopped: false,
		});
		expect(plan).toEqual({ start: ['b'], waiting: [] });
	});

	it('never starts a completed or running migration again', () => {
		const plan = planMigrationStarts(
			entries,
			states({ a: 'completed', b: 'running', c: 'completed' }),
			{ resumeStopped: true }
		);
		expect(plan).toEqual({ start: [], waiting: [] });
	});

	it('resumes failed and interrupted migrations only on an explicit run', () => {
		const stopped = states({ a: 'failed', c: 'interrupted' });
		expect(planMigrationStarts(entries, stopped, { resumeStopped: true })).toEqual({
			start: ['a', 'c'],
			waiting: ['b'],
		});
		expect(planMigrationStarts(entries, stopped, { resumeStopped: false })).toEqual({
			start: [],
			waiting: ['b'],
		});
	});
});

describe('firstStoppedMigration', () => {
	it('names the first failed or interrupted migration in manifest order', () => {
		const entries = [entry('a'), entry('b'), entry('c')];
		expect(firstStoppedMigration(entries, states({ a: 'running', c: 'failed' }))).toBe('c');
		expect(firstStoppedMigration(entries, states({ a: 'running' }))).toBeNull();
	});
});

describe('stepping stones', () => {
	const stone = entry('s', { introducedIn: '0.6.12', isSteppingStone: true });

	it('blocks any later release by default, but not a reinstall of its own', () => {
		expect(blocksUpdateTo(stone, '0.6.13')).toBe(true);
		expect(blocksUpdateTo(stone, '0.7.0')).toBe(true);
		expect(blocksUpdateTo(stone, '0.6.12')).toBe(false);
	});

	it('blocks only from `requiredBefore` when one is named', () => {
		const later = { ...stone, requiredBefore: '0.6.14' };
		expect(blocksUpdateTo(later, '0.6.13')).toBe(false);
		expect(blocksUpdateTo(later, '0.6.14')).toBe(true);
	});

	it('never blocks for an ordinary migration', () => {
		expect(blocksUpdateTo(entry('a'), '9.0.0')).toBe(false);
	});

	it('lists the unfinished stepping stones that hold back the target', () => {
		const entries = [
			stone,
			entry('t', { introducedIn: '0.6.12', isSteppingStone: true }),
			entry('a'),
		];
		expect(updateBlockers(entries, states({ s: 'completed', t: 'running' }), '0.6.13')).toEqual([
			't',
		]);
		expect(updateBlockers(entries, states({ s: 'completed', t: 'completed' }), '0.6.13')).toEqual(
			[]
		);
	});
});

describe('failedPageError', () => {
	const job = (name: string, kind: string, error?: string) => ({
		name,
		state: error === undefined ? { kind } : { kind, error },
	});

	it("returns the error of the migration's newest page job when it failed", () => {
		expect(
			failedPageError('0053_x', [
				job('migrations/0053_x.js:projectPage', 'success'),
				job('other/module:fn', 'failed', 'not ours'),
				job('migrations/0053_x.js:projectPage', 'failed', 'Row k1 cannot be mapped'),
			])
		).toBe('Row k1 cannot be mapped');
	});

	it('ignores an older failure once a newer page job exists', () => {
		expect(
			failedPageError('0053_x', [
				job('migrations/0053_x:projectPage', 'failed', 'old'),
				job('migrations/0053_x:projectPage', 'pending'),
			])
		).toBeNull();
	});

	it('does not confuse a migration with one whose name it prefixes', () => {
		expect(
			failedPageError('0053_x', [job('migrations/0053_xy:projectPage', 'failed', 'other')])
		).toBeNull();
	});
});
