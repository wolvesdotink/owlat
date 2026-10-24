/**
 * The data migrations card on System & updates (#1345): each manifest
 * migration with its state and progress, the run action, and a run that only
 * starts background work, never reported as done.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { MigrationRow } from '~/utils/systemMigrations';

import MigrationsCard from '../MigrationsCard.vue';

const NOW = Date.UTC(2026, 9, 13, 12);
const mutationMock = vi.fn();
const showToast = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	mutationMock.mockReset();
	showToast.mockReset();
	vi.stubGlobal('useConvex', () => ({ mutation: mutationMock }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useNow', () => ref(NOW));
});

function row(overrides: Partial<MigrationRow>): MigrationRow {
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

const progress = (completedAt: number | null) => ({
	startedAt: NOW - 60_000,
	updatedAt: NOW - 1_000,
	completedAt,
	pageCount: 4,
	scannedCount: 400,
	changedCount: 17,
});

function mountCard(data: unknown) {
	vi.stubGlobal('useConvexQuery', () => ({
		data: computed(() => data),
		error: computed(() => null),
		refetch: vi.fn(),
	}));
	return mount(MigrationsCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiQueryBoundary: { template: '<div data-test="boundary" />' },
				UiButton: {
					props: ['disabled'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('MigrationsCard', () => {
	it('shows each state with its progress, error and prerequisites', () => {
		const wrapper = mountCard({
			runner: null,
			migrations: [
				row({ state: 'completed', progress: progress(NOW - 5_000) }),
				row({
					migration: '0055_repair_repeated_block_ids',
					introducedIn: '0.6.7',
					state: 'failed',
					error: 'Template k1 has an unreadable block',
					progress: progress(null),
				}),
				row({
					migration: '0067_empty_retired_summaries',
					introducedIn: '0.6.12',
					state: 'running',
					stalledAt: NOW + 60_000,
					isSteppingStone: true,
					progress: progress(null),
				}),
				row({
					migration: '0068_seal_fact_keys',
					introducedIn: '0.6.12',
					waitingFor: ['0067_empty_retired_summaries'],
					isSteppingStone: true,
				}),
			],
		});

		const text = (name: string) => wrapper.find(`[data-test="migration-${name}"]`).text();
		expect(text('0053_project_open_commitments')).toContain('Completed');
		expect(text('0053_project_open_commitments')).toContain('400 rows checked, 17 changed');
		expect(text('0055_repair_repeated_block_ids')).toContain('Failed');
		expect(text('0055_repair_repeated_block_ids')).toContain('Template k1 has an unreadable block');
		expect(text('0067_empty_retired_summaries')).toContain('Running');
		expect(text('0067_empty_retired_summaries')).toContain(
			'Must complete before you update past 0.6.12.'
		);
		expect(text('0068_seal_fact_keys')).toContain('Waiting');
		expect(text('0068_seal_fact_keys')).toContain(
			'Starts after Remove retired thread summaries has completed.'
		);
		// Newest release first.
		expect(wrapper.findAll('h4').map((h) => h.text())).toEqual([
			'Introduced in 0.6.12',
			'Introduced in 0.6.7',
			'Introduced in 0.6.6',
		]);
		expectFullyLocalized(wrapper);
	});

	it('shows a running pass that stopped moving as interrupted, with how to resume', () => {
		const wrapper = mountCard({
			runner: null,
			migrations: [row({ state: 'running', stalledAt: NOW - 1, progress: progress(null) })],
		});
		expect(wrapper.text()).toContain('Interrupted');
		expect(wrapper.text()).toContain('Run again to resume from the last recorded page.');
	});

	it('reports a run as started in the background, not as done', async () => {
		mutationMock.mockResolvedValue({
			outcome: 'started',
			started: ['0053_a'],
			waiting: ['0060_b'],
		});
		const wrapper = mountCard({ runner: null, migrations: [row({})] });

		await wrapper.find('button').trigger('click');
		await flushPromises();

		expect(mutationMock).toHaveBeenCalledOnce();
		expect(showToast).toHaveBeenCalledWith(
			'Started 2 migrations. They run in the background; this list shows their progress.'
		);
	});

	it('holds the run action while a runner is active and when nothing is left', () => {
		const active = mountCard({
			runner: { status: 'active', startedAt: NOW, updatedAt: NOW - 1_000, finishedAt: null },
			migrations: [
				row({ state: 'running', stalledAt: NOW + 60_000 }),
				row({ migration: '0060_x' }),
			],
		});
		expect(active.find('button').attributes('disabled')).toBeDefined();
		expect(active.find('[role="status"]').text()).toContain(
			'Migrations are running in the background.'
		);

		const done = mountCard({
			runner: { status: 'finished', startedAt: NOW, updatedAt: NOW, finishedAt: NOW },
			migrations: [row({ state: 'completed', progress: progress(NOW) })],
		});
		expect(done.find('button').attributes('disabled')).toBeDefined();
		expect(done.text()).toContain('Every migration of this release has completed.');
	});

	it('says a self-starting migration that recorded its failure does not restart by itself', () => {
		const FOLDERS = '0054_backfill_folder_membership';
		const wrapper = mountCard({
			runner: null,
			migrations: [
				row({
					migration: FOLDERS,
					introducedIn: '0.6.7',
					startsItself: true,
					state: 'failed',
					hasRecordedFailure: true,
					error: 'Folder k1: The folder walk step failed',
					progress: progress(null),
				}),
			],
		});
		const text = wrapper.find(`[data-test="migration-${FOLDERS}"]`).text();
		expect(text).toContain(
			'After this failure it does not restart by itself. Fix the cause, then run it here to retry.'
		);
		expect(text).not.toContain('Running it here only starts it sooner');
		expectFullyLocalized(wrapper);
	});

	it('keeps the starts-by-itself hint while such a migration is still running', () => {
		const FOLDERS = '0054_backfill_folder_membership';
		const wrapper = mountCard({
			runner: null,
			migrations: [
				row({
					migration: FOLDERS,
					introducedIn: '0.6.7',
					startsItself: true,
					state: 'running',
					stalledAt: NOW + 60_000,
					progress: progress(null),
				}),
			],
		});
		const text = wrapper.find(`[data-test="migration-${FOLDERS}"]`).text();
		expect(text).toContain('Also starts by itself in the background.');
		expect(text).not.toContain('does not restart by itself');
	});

	it('names the migration that stopped the runner, with its error', () => {
		const wrapper = mountCard({
			runner: {
				status: 'stopped',
				startedAt: NOW,
				updatedAt: NOW,
				finishedAt: NOW,
				stoppedMigration: '0055_repair_repeated_block_ids',
				stoppedError: 'Template k1 has an unreadable block',
			},
			migrations: [row({ migration: '0055_repair_repeated_block_ids', state: 'failed' })],
		});
		const alert = wrapper.find('[role="alert"]').text();
		expect(alert).toContain(
			'No further migrations start: Repeated block ids in saved emails stopped the run.'
		);
		expect(alert).toContain('Template k1 has an unreadable block');
		expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
	});

	it('says which workers a contract step waits for', () => {
		const wrapper = mountCard({
			runner: null,
			migrations: [
				row({
					waitingForWorkers: [
						{ service: 'mta', requiredWireVersion: 2, reason: 'lagging', oldestLiveWireVersion: 1 },
						{
							service: 'mail-sync',
							requiredWireVersion: 2,
							reason: 'missing',
							oldestLiveWireVersion: null,
						},
					],
				}),
			],
		});

		expect(wrapper.text()).toContain('Waiting');
		expect(wrapper.find('[data-test="worker-wait-mta"]').text()).toBe(
			'MTA: waits until every worker runs wire version 2 or newer. One still runs 1.'
		);
		expect(wrapper.find('[data-test="worker-wait-mail-sync"]').text()).toBe(
			'Mail sync: waits for a worker to report wire version 2 or newer.'
		);
		expectFullyLocalized(wrapper);
	});
});
