/**
 * Data migrations from Settings → System & updates (migrations/admin.ts):
 * platform admins only, pending migrations start through their own `run`,
 * completed ones are left alone, a second click does not start a second
 * execution, an interrupted pass resumes from its cursor, dependencies run in
 * order, and unfinished stepping stones hold back an update.
 *
 * The `authedQuery` / `authedMutation` org floor is mocked to pass, as in
 * systemUpdates.integration.test.ts, so `requirePlatformAdmin` is the gate
 * under test: the caller is an org owner, which is not a platform admin.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as ManifestModule from '../migrations/manifest';
import { scheduleMigrationPage } from '../lib/migrationLedger';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';

const sessionMock = vi.hoisted(() => ({ subject: 'admin-user' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.subject),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
			subject: sessionMock.subject,
			issuer: 'test',
			tokenIdentifier: `test|${sessionMock.subject}`,
		})),
	};
});

// The shipped manifest has no dependencies yet. Make 0060 wait for 0053 so
// the runner's ordering is exercised on real migrations.
const DEPENDENT = '0060_saved_reply_scopes';
const DEPENDENCY = '0053_project_open_commitments';
vi.mock('../migrations/manifest', async () => {
	const actual = await vi.importActual<typeof ManifestModule>('../migrations/manifest');
	return {
		...actual,
		MIGRATION_MANIFEST: actual.MIGRATION_MANIFEST.map((entry) =>
			entry.migration === '0060_saved_reply_scopes'
				? { ...entry, dependsOn: ['0053_project_open_commitments'] }
				: entry
		),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type T = TestConvex<typeof schema>;

const STONES = ['0067_empty_retired_summaries', '0068_seal_fact_keys'];

function setup() {
	return convexTest(schema, modules);
}

async function seedAdmin(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert('platformAdmins', {
			authUserId: 'admin-user',
			email: 'admin@example.com',
			role: 'admin',
			createdAt: Date.now(),
		});
	});
}

async function seedRun(
	t: T,
	migration: string,
	fields: { status: 'running' | 'completed'; updatedAt: number; cursor?: string }
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('migrationRuns', {
			migration,
			introducedIn: '0.6.0',
			generation: 1,
			pageCount: 3,
			scannedCount: 300,
			changedCount: 12,
			startedAt: fields.updatedAt - 1_000,
			...fields,
			...(fields.status === 'completed' ? { completedAt: fields.updatedAt } : {}),
		});
	});
}

async function ledgerRow(t: T, migration: string) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', migration))
			.unique()
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	sessionMock.subject = 'admin-user';
});
afterEach(() => {
	vi.useRealTimers();
});

describe('permission boundary', () => {
	it('refuses an org owner who is not a platform admin, for every entry point', async () => {
		const t = setup();
		const refused = /Platform admin access required/;
		await expect(t.query(api.migrations.admin.list, {})).rejects.toThrow(refused);
		await expect(
			t.query(api.migrations.admin.updateBlockers, { targetVersion: '0.6.13' })
		).rejects.toThrow(refused);
		await expect(t.mutation(api.migrations.admin.runPending, {})).rejects.toThrow(refused);
		const rows = await t.run(async (ctx) => ctx.db.query('migrationRuns').collect());
		expect(rows).toEqual([]);
	});
});

describe('runPending', () => {
	it('starts the pending migrations in the background and reports them running, not done', async () => {
		const t = setup();
		await seedAdmin(t);

		const before = await t.query(api.migrations.admin.list, {});
		expect(before.migrations.every((m) => m.state === 'pending')).toBe(true);
		expect(before.migrations.find((m) => m.migration === DEPENDENT)?.waitingFor).toEqual([
			DEPENDENCY,
		]);

		const result = await t.mutation(api.migrations.admin.runPending, {});
		expect(result.outcome).toBe('started');
		expect(result.started).toContain(DEPENDENCY);
		expect(result.started).not.toContain(DEPENDENT);
		expect(result.waiting).toEqual([DEPENDENT]);

		const during = await t.query(api.migrations.admin.list, {});
		const state = (name: string) => during.migrations.find((m) => m.migration === name)?.state;
		expect(state(DEPENDENCY)).toBe('running');
		expect(state(DEPENDENT)).toBe('pending');
		expect(during.runner?.status).toBe('active');
		// The chain recorded the page it waits on, for the live generation.
		const started = await ledgerRow(t, DEPENDENCY);
		expect(started!.pageJob?.generation).toBe(started!.generation);
		expect(await ledgerRow(t, DEPENDENT)).toBeNull();

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const after = await t.query(api.migrations.admin.list, {});
		expect(after.migrations.every((m) => m.state === 'completed')).toBe(true);
		expect(after.runner?.status).toBe('finished');
		// The dependent started only after its dependency had completed.
		const dependency = await ledgerRow(t, DEPENDENCY);
		const dependent = await ledgerRow(t, DEPENDENT);
		expect(dependent!.startedAt).toBeGreaterThanOrEqual(dependency!.completedAt!);
	});

	it('does not start a second execution on a repeated click', async () => {
		const t = setup();
		await seedAdmin(t);
		await t.mutation(api.migrations.admin.runPending, {});
		const generation = (await ledgerRow(t, DEPENDENCY))!.generation;

		const again = await t.mutation(api.migrations.admin.runPending, {});
		expect(again.outcome).toBe('alreadyRunning');
		expect((await ledgerRow(t, DEPENDENCY))!.generation).toBe(generation);
	});

	it('skips a completed migration and reports nothing to run once all are done', async () => {
		const t = setup();
		await seedAdmin(t);
		await seedRun(t, DEPENDENCY, { status: 'completed', updatedAt: Date.now() });

		const result = await t.mutation(api.migrations.admin.runPending, {});
		expect(result.started).not.toContain(DEPENDENCY);
		// Its dependent no longer waits.
		expect(result.started).toContain(DEPENDENT);
		const row = await ledgerRow(t, DEPENDENCY);
		expect(row!.generation).toBe(1);
		expect(row!.status).toBe('completed');

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await t.mutation(api.migrations.admin.runPending, {})).outcome).toBe('nothingToRun');
	});

	it('shows a pass that stopped moving as interrupted and resumes it from its cursor', async () => {
		const t = setup();
		await seedAdmin(t);
		await seedRun(t, DEPENDENCY, {
			status: 'running',
			updatedAt: Date.now() - 60 * 60_000,
			cursor: 'stored-cursor',
		});

		const listed = await t.query(api.migrations.admin.list, {});
		const interrupted = listed.migrations.find((m) => m.migration === DEPENDENCY)!;
		expect(interrupted.state).toBe('interrupted');
		expect(interrupted.progress).toMatchObject({ scannedCount: 300, changedCount: 12 });

		const result = await t.mutation(api.migrations.admin.runPending, {});
		expect(result.started).toContain(DEPENDENCY);
		const row = await ledgerRow(t, DEPENDENCY);
		// A resume: a new generation, the recorded cursor and counts kept.
		expect(row).toMatchObject({
			status: 'running',
			generation: 2,
			cursor: 'stored-cursor',
			scannedCount: 300,
		});
	});

	it('stops the runner when a migration stops moving, and the next run resumes it', async () => {
		const t = setup();
		await seedAdmin(t);
		await t.mutation(api.migrations.admin.runPending, {});
		// Simulate a page chain that died: the row stays running and stops moving.
		const runner = await t.run(async (ctx) => (await ctx.db.query('migrationDriver').first())!);
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', DEPENDENCY))
				.unique();
			await ctx.db.patch(row!._id, {
				status: 'running',
				completedAt: undefined,
				updatedAt: Date.now() - 60 * 60_000,
				generation: row!.generation + 100,
			});
		});
		await t.mutation(internal.migrations.admin.advance, { generation: runner.generation });

		const listed = await t.query(api.migrations.admin.list, {});
		expect(listed.runner).toMatchObject({ status: 'stopped', stoppedMigration: DEPENDENCY });
		expect(listed.runner?.stoppedError).toBeTruthy();

		const resumed = await t.mutation(api.migrations.admin.runPending, {});
		expect(resumed.outcome).toBe('started');
		expect(resumed.started).toContain(DEPENDENCY);
	});
});

describe('failed jobs', () => {
	it('reports a delayed poll that failed long after the last ledger write, with its error', async () => {
		expectScheduledFailure('migrations/0054_backfill_folder_membership:finish');
		const t = setup();
		await seedAdmin(t);
		const FOLDERS = '0054_backfill_folder_membership';
		// 0054 waits for its folder walks by polling `finish` every minute, and
		// the poll does not move the ledger row: the last write is half an hour old.
		await seedRun(t, FOLDERS, { status: 'running', updatedAt: Date.now() - 30 * 60_000 });
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', FOLDERS))
				.unique();
			// A poll the function rejects when it runs.
			await scheduleMigrationPage(ctx, row!, 60_000, internal.migrations[FOLDERS].finish, {
				cursor: null,
				generation: 'not-a-generation' as unknown as number,
			});
		});
		const before = await t.query(api.migrations.admin.list, {});
		expect(before.migrations.find((m) => m.migration === FOLDERS)?.state).toBe('running');

		vi.advanceTimersByTime(61_000);
		await t.finishInProgressScheduledFunctions();

		const listed = await t.query(api.migrations.admin.list, {});
		const folders = listed.migrations.find((m) => m.migration === FOLDERS)!;
		expect(folders.state).toBe('failed');
		// The job's own error where the backend keeps it (convex-test does not),
		// otherwise a stated fallback; never an empty card.
		expect(folders.error).toBeTruthy();
	});
});

describe('0054 folder walks', () => {
	const FOLDERS = '0054_backfill_folder_membership';
	const folders = internal.migrations[FOLDERS];
	const STEP = 'maintenance/folderMembershipBackfill:step';

	/** `count` folders whose walk has a stored cursor no page can read: every step throws. */
	async function seedFailingWalks(t: T, count: number) {
		const mailboxId = await seedMailbox(t);
		const folderIds: Id<'mailFolders'>[] = [];
		for (let i = 0; i < count; i++) folderIds.push(await seedFolder(t, mailboxId));
		await seedMessage(t, mailboxId, { subject: 's' });
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const folderId of folderIds) {
				await ctx.db.insert('mailFolderMembership', {
					folderId,
					isReady: false,
					revision: 0,
					cursor: 'not-a-cursor',
					startedAt: now,
					updatedAt: now,
				});
			}
		});
		return folderIds;
	}

	const walkOf = (t: T, folderId: Id<'mailFolders'>) =>
		t.run(async (ctx) =>
			ctx.db
				.query('mailFolderMembership')
				.withIndex('by_folder', (q) => q.eq('folderId', folderId))
				.unique()
		);

	const stateOf = async (t: T) =>
		(await t.query(api.migrations.admin.list, {})).migrations.find((m) => m.migration === FOLDERS)!;

	/** Simulated minutes at production cadence: `finish` polls each minute, the cron every ten. */
	async function minutes(t: T, count: number, onMinute?: (minute: number) => Promise<void>) {
		for (let minute = 1; minute <= count; minute++) {
			vi.advanceTimersByTime(60_000);
			await t.finishInProgressScheduledFunctions();
			await onMinute?.(minute);
		}
	}

	it('fails the migration once a folder walk keeps failing, and the card shows it', async () => {
		expectScheduledFailure(STEP);
		const t = setup();
		await seedAdmin(t);
		const [folderId] = await seedFailingWalks(t, 1);

		await t.mutation(folders.run, {});
		// `finish` polls every minute and restarts the stalled walk every ten,
		// counting each failed step; the third one stops the polling.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const row = await stateOf(t);
		expect(row.state).toBe('failed');
		expect(row.error).toContain(`Folder ${folderId}`);
		expect(row.hasRecordedFailure).toBe(true);
		expect((await walkOf(t, folderId!))!.walkFailures?.count).toBe(3);

		// The cron does not resume a pass that failed on a folder, even after an hour.
		const generation = (await ledgerRow(t, FOLDERS))!.generation;
		vi.advanceTimersByTime(2 * 60 * 60_000);
		expect(await t.mutation(folders.ensure, {})).toEqual({ started: false });
		expect((await ledgerRow(t, FOLDERS))!.generation).toBe(generation);

		// An explicit run resumes it, with the failure cleared and a fresh streak.
		const resumed = await t.mutation(api.migrations.admin.runPending, {});
		expect(resumed.started).toContain(FOLDERS);
		const after = await ledgerRow(t, FOLDERS);
		expect(after).toMatchObject({ status: 'running', generation: generation + 1 });
		expect(after!.failure).toBeUndefined();
		expect(after!.retryEpoch).toBe(2);
	});

	it('reaches Failed with many failing folders at cron cadence, across an automatic resume', async () => {
		expectScheduledFailure(STEP);
		const t = setup();
		await seedAdmin(t);
		await seedFailingWalks(t, 40);

		await t.mutation(api.migrations.admin.runPending, {});
		const started = (await ledgerRow(t, FOLDERS))!;
		let failedAt: number | null = null;
		await minutes(t, 60, async (minute) => {
			if (minute % 10 === 0) {
				// At minute 20 the ledger row has been still for an hour, so the
				// cron's resume runs and bumps the generation mid-streak.
				if (minute === 20) {
					await t.run(async (ctx) => {
						await ctx.db.patch(started._id, { updatedAt: Date.now() - 61 * 60_000 });
					});
				}
				await t.mutation(folders.ensure, {});
			}
			if (failedAt === null && (await stateOf(t)).state === 'failed') failedAt = minute;
		});

		expect(failedAt).not.toBeNull();
		// Three ten-minute rounds of failed steps: the resume at minute 20 must not
		// start the streaks over (keyed to the generation, this took 55 minutes).
		expect(failedAt!).toBeLessThanOrEqual(35);
		const ledger = (await ledgerRow(t, FOLDERS))!;
		// The cron's resume happened, and did not wipe the streaks.
		expect(ledger.generation).toBeGreaterThan(started.generation);
		expect(ledger.retryEpoch).toBe(started.retryEpoch);
		const listed = await t.query(api.migrations.admin.list, {});
		expect(listed.runner).toMatchObject({ status: 'stopped', stoppedMigration: FOLDERS });
	});

	it("never counts a step that failed before the operator's retry toward the new streak", async () => {
		expectScheduledFailure(STEP);
		const t = setup();
		await seedAdmin(t);
		const [folderId] = await seedFailingWalks(t, 1);

		await t.mutation(folders.run, {});
		await minutes(t, 2);
		const before = (await walkOf(t, folderId!))!;
		expect(before.walkJob?.epoch).toBe(1);

		// The operator retries while that failed step is still the recorded one.
		await t.mutation(folders.run, {});
		expect((await ledgerRow(t, FOLDERS))!.retryEpoch).toBe(2);

		// The first stalled poll restarts the walk without counting the old step.
		await minutes(t, 11);
		const restarted = (await walkOf(t, folderId!))!;
		expect(restarted.walkFailures).toBeUndefined();
		expect(restarted.walkJob?.epoch).toBe(2);

		await minutes(t, 40);
		const failed = (await walkOf(t, folderId!))!;
		expect((await stateOf(t)).state).toBe('failed');
		expect(failed.walkFailures).toMatchObject({ epoch: 2, count: 3 });
		// Four failed steps in all: the one before the retry, and three after it.
		const failedSteps = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.name.replace(/\.js(?=:)/, '') === STEP && job.state.kind === 'failed'
			)
		);
		expect(failedSteps).toHaveLength(4);
	});
});

describe('updateBlockers', () => {
	it('names the unfinished stepping stones for a later release only', async () => {
		const t = setup();
		await seedAdmin(t);
		const blockers = await t.query(api.migrations.admin.updateBlockers, {
			targetVersion: '0.6.13',
		});
		expect(blockers.map((b) => b.migration)).toEqual(STONES);
		expect(await t.query(api.migrations.admin.updateBlockers, { targetVersion: '0.6.12' })).toEqual(
			[]
		);

		for (const stone of STONES) {
			await seedRun(t, stone, { status: 'completed', updatedAt: Date.now() });
		}
		expect(await t.query(api.migrations.admin.updateBlockers, { targetVersion: '0.6.13' })).toEqual(
			[]
		);
	});

	it('rejects a target that is not a version', async () => {
		const t = setup();
		await seedAdmin(t);
		await expect(
			t.query(api.migrations.admin.updateBlockers, { targetVersion: 'latest' })
		).rejects.toThrow();
	});
});
