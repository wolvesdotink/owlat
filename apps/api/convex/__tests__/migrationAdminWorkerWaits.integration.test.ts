/**
 * Contract steps from Settings → System & updates wait for the workers
 * (migrations/admin.ts with maintenance/workerRegistry.ts): a migration that
 * declares `requiresWorkers` is listed with what it waits on and is not
 * started, by the admin's run or by the runner's ticks, until every live worker
 * of that service reports the version it needs.
 *
 * Its own `run` refuses the same way (lib/migrationLedger.ts), so the CLI, a
 * cron or a resume cannot start it under a lagging worker either.
 *
 * The shipped manifest has no such step yet, so 0053 is made one here: it
 * needs MTA wire 2.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { MIGRATION_MANIFEST } from '../migrations/manifest';
import type * as ManifestModule from '../migrations/manifest';
import { WORKER_LIVE_WINDOW_MS } from '../maintenance/workerRegistry';
import { modules } from './testModulesWithoutNodeActions';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('admin-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'admin-user',
			issuer: 'test',
			tokenIdentifier: 'test|admin-user',
		}),
	};
});

const CONTRACT = '0053_project_open_commitments';
vi.mock('../migrations/manifest', async () => {
	const actual = await vi.importActual<typeof ManifestModule>('../migrations/manifest');
	return {
		...actual,
		MIGRATION_MANIFEST: actual.MIGRATION_MANIFEST.map((entry) =>
			entry.migration === '0053_project_open_commitments'
				? { ...entry, requiresWorkers: { mta: 2 } }
				: entry
		),
	};
});

type T = TestConvex<typeof schema>;

const T0 = Date.UTC(2026, 9, 1, 12);

// Every timer is fake: the page chains `runPending` schedules stay queued, and
// only the runner ticks the test calls itself run.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedAdmin(t: T) {
	await t.run((ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId: 'admin-user',
			email: 'admin@example.com',
			role: 'admin',
			createdAt: T0,
		})
	);
}

/** Every other migration has completed, so only the contract step is left. */
async function completeOthers(t: T) {
	await t.run(async (ctx) => {
		for (const entry of MIGRATION_MANIFEST) {
			if (entry.migration === CONTRACT) continue;
			await ctx.db.insert('migrationRuns', {
				migration: entry.migration,
				introducedIn: entry.introducedIn,
				status: 'completed',
				generation: 1,
				pageCount: 1,
				scannedCount: 0,
				changedCount: 0,
				startedAt: T0 - 1000,
				updatedAt: T0 - 500,
				completedAt: T0 - 500,
			});
		}
	});
}

const reportMta = (t: T, hostLabel: string, wireVersion: number) =>
	t.mutation(internal.maintenance.workerRegistry.report, {
		service: 'mta',
		instanceId: `proc-${hostLabel}`,
		hostLabel,
		owlatVersion: '0.6.17',
		wireVersion,
		startedAt: T0,
	});

const ledgerRow = (t: T, migration: string) =>
	t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', migration))
			.unique()
	);

describe('a contract step that needs the workers to move', () => {
	it('waits while an MTA still runs the old contract, then starts on the next tick', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		await completeOthers(t);
		await reportMta(t, 'mta-new', 2);
		await reportMta(t, 'mta-old', 1);

		const listed = await t.query(api.migrations.admin.list, {});
		const contract = listed.migrations.find((m) => m.migration === CONTRACT)!;
		expect(contract.state).toBe('pending');
		expect(contract.waitingForWorkers).toEqual([
			{ service: 'mta', requiredWireVersion: 2, reason: 'lagging', oldestLiveWireVersion: 1 },
		]);
		// The other migrations do not wait on anything.
		expect(
			listed.migrations
				.filter((m) => m.migration !== CONTRACT)
				.every((m) => m.waitingForWorkers.length === 0)
		).toBe(true);

		const run = await t.mutation(api.migrations.admin.runPending, {});
		expect(run).toEqual({ outcome: 'started', started: [], waiting: [CONTRACT] });
		expect(await ledgerRow(t, CONTRACT)).toBeNull();

		const runner = await t.run(async (ctx) => (await ctx.db.query('migrationDriver').first())!);
		// A tick while the old MTA still reports starts nothing.
		vi.setSystemTime(T0 + 5 * 60_000);
		await reportMta(t, 'mta-old', 1);
		await reportMta(t, 'mta-new', 2);
		await t.mutation(internal.migrations.admin.advance, { generation: runner.generation });
		expect(await ledgerRow(t, CONTRACT)).toBeNull();

		// The old MTA was replaced: it stops reporting and leaves the live window.
		vi.setSystemTime(T0 + 5 * 60_000 + WORKER_LIVE_WINDOW_MS + 1);
		await reportMta(t, 'mta-new', 2);
		const tick = await t.mutation(internal.migrations.admin.advance, {
			generation: runner.generation,
		});
		expect(tick.outcome).toBe('active');
		expect(await ledgerRow(t, CONTRACT)).toMatchObject({ status: 'running' });

		const after = await t.query(api.migrations.admin.list, {});
		expect(after.migrations.find((m) => m.migration === CONTRACT)!.waitingForWorkers).toEqual([]);
	});

	it('waits for evidence from an MTA the backend is configured to use', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const saved = process.env['MTA_API_URL'];
		process.env['MTA_API_URL'] = 'http://mta.owlat.example:3100';
		try {
			const run = await t.mutation(api.migrations.admin.runPending, {});
			expect(run.waiting).toContain(CONTRACT);
			const listed = await t.query(api.migrations.admin.list, {});
			expect(listed.migrations.find((m) => m.migration === CONTRACT)!.waitingForWorkers).toEqual([
				{ service: 'mta', requiredWireVersion: 2, reason: 'missing', oldestLiveWireVersion: null },
			]);
		} finally {
			if (saved === undefined) delete process.env['MTA_API_URL'];
			else process.env['MTA_API_URL'] = saved;
		}
	});

	it('does not hold the step on a service this deployment does not run', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const saved = process.env['MTA_API_URL'];
		delete process.env['MTA_API_URL'];
		try {
			const run = await t.mutation(api.migrations.admin.runPending, {});
			expect(run.started).toContain(CONTRACT);
		} finally {
			if (saved !== undefined) process.env['MTA_API_URL'] = saved;
		}
	});
});

describe('a contract step started without the runner', () => {
	const runContract = (t: T, args: { restart?: boolean } = {}) =>
		t.mutation(internal.migrations['0053_project_open_commitments'].run, args);

	async function seedContractRun(t: T, status: 'running' | 'completed') {
		await t.run((ctx) =>
			ctx.db.insert('migrationRuns', {
				migration: CONTRACT,
				introducedIn: '0.6.6',
				status,
				generation: 3,
				cursor: 'page-2',
				pageCount: 2,
				scannedCount: 10,
				changedCount: 4,
				startedAt: T0 - 60 * 60_000,
				updatedAt: T0 - 30 * 60_000,
				...(status === 'completed' ? { completedAt: T0 - 30 * 60_000 } : {}),
			})
		);
	}

	it('refuses a direct start while an MTA still runs the old contract', async () => {
		const t = convexTest(schema, modules);
		await reportMta(t, 'mta-new', 2);
		await reportMta(t, 'mta-old', 1);

		await expect(runContract(t)).rejects.toThrow(/waits for workers to move: mta/);
		expect(await ledgerRow(t, CONTRACT)).toBeNull();

		// Once the old MTA has left the live window, the same call starts the pass.
		vi.setSystemTime(T0 + WORKER_LIVE_WINDOW_MS + 1);
		await reportMta(t, 'mta-new', 2);
		expect(await runContract(t)).toMatchObject({ started: true });
		expect(await ledgerRow(t, CONTRACT)).toMatchObject({ status: 'running', generation: 1 });
	});

	it('refuses a direct start while a configured MTA has not reported the version', async () => {
		const t = convexTest(schema, modules);
		const saved = process.env['MTA_API_URL'];
		process.env['MTA_API_URL'] = 'http://mta.owlat.example:3100';
		try {
			await expect(runContract(t)).rejects.toThrow(/no live worker reports wire 2/);
			expect(await ledgerRow(t, CONTRACT)).toBeNull();
		} finally {
			if (saved === undefined) delete process.env['MTA_API_URL'];
			else process.env['MTA_API_URL'] = saved;
		}
	});

	it('refuses to resume an interrupted pass, leaving its row as it was', async () => {
		const t = convexTest(schema, modules);
		await seedContractRun(t, 'running');
		await reportMta(t, 'mta-old', 1);

		await expect(runContract(t)).rejects.toThrow(/waits for workers to move/);
		expect(await ledgerRow(t, CONTRACT)).toMatchObject({
			status: 'running',
			generation: 3,
			cursor: 'page-2',
			updatedAt: T0 - 30 * 60_000,
		});

		await reportMta(t, 'mta-old', 2);
		vi.setSystemTime(T0 + WORKER_LIVE_WINDOW_MS + 1);
		await reportMta(t, 'mta-old', 2);
		expect(await runContract(t)).toMatchObject({ started: true, generation: 4 });
		expect(await ledgerRow(t, CONTRACT)).toMatchObject({ generation: 4, cursor: 'page-2' });
	});

	it('refuses a restart of a completed pass, and leaves a plain run of one alone', async () => {
		const t = convexTest(schema, modules);
		await seedContractRun(t, 'completed');
		await reportMta(t, 'mta-old', 1);

		// Nothing to start: the completed pass is not touched, so nothing is refused.
		expect(await runContract(t)).toMatchObject({ started: false });
		await expect(runContract(t, { restart: true })).rejects.toThrow(/waits for workers to move/);
		expect(await ledgerRow(t, CONTRACT)).toMatchObject({ status: 'completed', generation: 3 });
	});
});
