/**
 * How a data-migration row reads on System & updates (utils/systemMigrations):
 * a running pass that stops moving turns interrupted without a new answer, a
 * pending one with an open dependency waits, and an active runner holds the
 * run action only while it still ticks.
 */
import { describe, expect, it } from 'vitest';
import { semverCompare } from '@owlat/shared/semver';
import {
	countByState,
	displayState,
	groupByRelease,
	isRunnable,
	isRunnerActive,
	migrationNameKey,
	RUNNER_STALE_MS,
	type MigrationRow,
} from '../systemMigrations';

const NOW = Date.UTC(2026, 9, 13, 12);

function row(overrides: Partial<MigrationRow> = {}): MigrationRow {
	return {
		migration: '0053_project_open_commitments',
		introducedIn: '0.6.6',
		waitingFor: [],
		isSteppingStone: false,
		requiredBefore: null,
		startsItself: false,
		hasRecordedFailure: false,
		state: 'pending',
		stalledAt: null,
		error: null,
		progress: null,
		...overrides,
	};
}

describe('displayState', () => {
	it('keeps a running pass running until its stall moment', () => {
		expect(displayState(row({ state: 'running', stalledAt: NOW + 1 }), NOW)).toBe('running');
	});

	it('turns a running pass interrupted once its stall moment passes', () => {
		expect(displayState(row({ state: 'running', stalledAt: NOW }), NOW)).toBe('interrupted');
	});

	it('shows a pending migration with an open dependency as waiting', () => {
		expect(displayState(row({ waitingFor: ['0052_x'] }), NOW)).toBe('waiting');
		expect(displayState(row(), NOW)).toBe('pending');
	});

	it('shows a pending contract step that waits for a worker as waiting', () => {
		const wait = {
			service: 'mta' as const,
			requiredWireVersion: 2,
			reason: 'lagging' as const,
			oldestLiveWireVersion: 1,
		};
		expect(displayState(row({ waitingForWorkers: [wait] }), NOW)).toBe('waiting');
		// From a backend without the field: nothing to wait for.
		expect(displayState(row({ waitingForWorkers: undefined }), NOW)).toBe('pending');
		expect(displayState(row({ waitingForWorkers: [] }), NOW)).toBe('pending');
	});

	it('passes the other states through', () => {
		for (const state of ['completed', 'failed', 'interrupted'] as const) {
			expect(displayState(row({ state }), NOW)).toBe(state);
		}
	});
});

describe('isRunnable', () => {
	it('offers the run action for everything that is neither running nor completed', () => {
		expect(
			['pending', 'waiting', 'failed', 'interrupted'].every((s) => isRunnable(s as never))
		).toBe(true);
		expect(isRunnable('running')).toBe(false);
		expect(isRunnable('completed')).toBe(false);
	});
});

describe('isRunnerActive', () => {
	it('holds the run action only while the runner still ticks', () => {
		expect(isRunnerActive({ status: 'active', updatedAt: NOW - 1_000 }, NOW)).toBe(true);
		expect(isRunnerActive({ status: 'active', updatedAt: NOW - RUNNER_STALE_MS }, NOW)).toBe(false);
		expect(isRunnerActive({ status: 'stopped', updatedAt: NOW }, NOW)).toBe(false);
		expect(isRunnerActive(null, NOW)).toBe(false);
	});
});

describe('countByState and groupByRelease', () => {
	const rows = [
		row({ migration: '0053_a', introducedIn: '0.6.6', state: 'completed' }),
		row({ migration: '0067_b', introducedIn: '0.6.12', state: 'running', stalledAt: NOW + 1 }),
		row({ migration: '0068_c', introducedIn: '0.6.12', waitingFor: ['0067_b'] }),
	];

	it('counts by the state the row shows now', () => {
		expect(countByState(rows, NOW)).toMatchObject({ completed: 1, running: 1, waiting: 1 });
		expect(countByState(rows, NOW + 1)).toMatchObject({ running: 0, interrupted: 1 });
	});

	it('groups by release, newest first, comparing versions numerically', () => {
		expect(
			groupByRelease(rows, semverCompare).map((g) => [g.version, g.rows.map((r) => r.migration)])
		).toEqual([
			['0.6.12', ['0067_b', '0068_c']],
			['0.6.6', ['0053_a']],
		]);
	});
});

it('keys a migration name by its number', () => {
	expect(migrationNameKey('0053_project_open_commitments')).toBe('m0053');
});
