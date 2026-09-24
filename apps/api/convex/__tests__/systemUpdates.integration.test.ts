/**
 * Integration tests for the update-run recording surface
 * (apps/api/convex/systemUpdates.ts).
 *
 * These two mutations are what `POST /api/system/update` (apps/web) calls
 * around its dispatch to the updater sidecar, and both were unreachable: they
 * were `internalMutation`s, while the route reaches Convex through a
 * session-authed `ConvexHttpClient`, which resolves the PUBLIC function
 * surface only. Every in-app update therefore died on
 *   "Could not find public function for 'systemUpdates:recordUpdateStart'"
 * — a 500 the type system could not see, because the route re-tagged the
 * internal reference as public to make it compile.
 *
 * So the point of these cases is that the pair is reachable the way the route
 * reaches it (`api.*`, not `internal.*`), that being public did not cost the
 * platform-admin gate, and that the step blob the sidecar really returns —
 * `ok` included — passes argument validation.
 *
 * The `authedMutation` org floor is mocked to pass, exactly as in
 * backups.integration.test.ts, so `requirePlatformAdmin` is the gate under test.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

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

const setCaller = (subject: string) => {
	sessionMock.subject = subject;
};

async function seedAdmin(
	t: ReturnType<typeof convexTest>,
	authUserId = 'admin-user'
): Promise<Id<'platformAdmins'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId,
			email: `${authUserId}@example.com`,
			role: 'admin',
			createdAt: Date.now(),
		})
	);
}

// What the updater sidecar actually returns: a per-step `ok` verdict alongside
// the captured output, plus the two compose-file steps that report without one.
const SIDECAR_STEPS = [
	{ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' },
	{ step: 'pull', ok: true, stdout: '', stderr: 'Pulling web ... done' },
	{ step: 'convex-deploy', ok: true, stdout: 'Deployed functions', stderr: '' },
	{ step: 'up', ok: true, stdout: 'Container owlat-web-1 Started', stderr: '' },
];

beforeEach(() => {
	setCaller('admin-user');
});

describe('systemUpdates.recordUpdateStart', () => {
	it('rejects a caller with no platformAdmins row (even an org owner)', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.systemUpdates.recordUpdateStart, {
				versionFrom: '0.4.16',
				versionTo: '0.4.17',
			})
		).rejects.toThrow(/Platform admin access required/);

		const rows = await t.run(async (ctx) => ctx.db.query('systemUpdates').collect());
		expect(rows).toHaveLength(0);
	});

	it('opens a running updateRun row stamped with the acting admin', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);

		const runId = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.4.16',
			versionTo: '0.4.17',
		});

		const run = await t.run(async (ctx) => ctx.db.get(runId));
		expect(run).toMatchObject({
			kind: 'updateRun',
			versionFrom: '0.4.16',
			versionTo: '0.4.17',
			status: 'running',
			// Derived from the session, never an argument — an audit trail whose
			// actor is caller-supplied records whatever the caller claims.
			initiatedBy: 'admin-user',
		});
		expect(run?.startedAt).toBeTypeOf('number');
	});
});

describe('systemUpdates.recordUpdateFinish', () => {
	async function openRun(t: ReturnType<typeof convexTest>): Promise<Id<'systemUpdates'>> {
		return await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.4.16',
			versionTo: '0.4.17',
		});
	}

	it('closes the run with the sidecar step blob verbatim, `ok` flags included', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const runId = await openRun(t);

		// Regression: `updateStepResultValidator` had no `ok` field, and Convex
		// object validators reject unknown ones — so this call used to fail
		// argument validation and no update run was ever closed out.
		await t.mutation(api.systemUpdates.recordUpdateFinish, {
			runId,
			status: 'success',
			steps: SIDECAR_STEPS,
		});

		const run = await t.run(async (ctx) => ctx.db.get(runId));
		expect(run?.status).toBe('success');
		expect(run?.steps).toEqual(SIDECAR_STEPS);
		expect(run?.finishedAt).toBeTypeOf('number');
	});

	it('records a failure with the updater error message', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const runId = await openRun(t);

		await t.mutation(api.systemUpdates.recordUpdateFinish, {
			runId,
			status: 'failed',
			error: 'Docker pull failed — update aborted, nothing changed',
			steps: [{ step: 'pull', ok: false, stdout: '', stderr: 'manifest unknown' }],
		});

		const history = await t.query(api.systemUpdates.listUpdateHistory, {});
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			status: 'failed',
			error: 'Docker pull failed — update aborted, nothing changed',
		});
	});

	it('rejects a caller with no platformAdmins row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const runId = await openRun(t);

		setCaller('not-a-platform-admin');
		await expect(
			t.mutation(api.systemUpdates.recordUpdateFinish, { runId, status: 'success' })
		).rejects.toThrow(/Platform admin access required/);

		const run = await t.run(async (ctx) => ctx.db.get(runId));
		expect(run?.status).toBe('running');
	});

	it('refuses an id that is not an updateRun — the release-check cache shares the table', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const checkId = await t.run(async (ctx) =>
			ctx.db.insert('systemUpdates', {
				kind: 'latestCheck',
				latestVersion: '0.4.17',
				checkedAt: Date.now(),
			})
		);

		await expect(
			t.mutation(api.systemUpdates.recordUpdateFinish, { runId: checkId, status: 'success' })
		).rejects.toThrow();

		const check = await t.run(async (ctx) => ctx.db.get(checkId));
		expect(check).toMatchObject({ kind: 'latestCheck', latestVersion: '0.4.17' });
		expect(check?.status).toBeUndefined();
	});
});

/**
 * THE RUN THAT NOBODY CLOSES.
 *
 * `recordUpdateFinish` is called by the Nitro route that dispatched the update,
 * and the update's last step recreates the container that route runs in — so on
 * the HAPPY path the recorder dies before the sidecar's answer reaches it, and
 * the row it opened stays `running` in the history table forever. The browser
 * outlives the restart and its health poller is the only party that learns how
 * the run ended; this is the lookup that hands it the row to close.
 */
describe('systemUpdates.getUnfinishedUpdate', () => {
	it('rejects a caller with no platformAdmins row', async () => {
		const t = convexTest(schema, modules);
		await expect(t.query(api.systemUpdates.getUnfinishedUpdate, {})).rejects.toThrow(
			/Platform admin access required/
		);
	});

	it('returns the run the restart orphaned', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const runId = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});

		expect(await t.query(api.systemUpdates.getUnfinishedUpdate, {})).toEqual({
			runId,
			versionTo: '0.5.3',
		});
	});

	it('returns nothing once the run is closed, so closing it twice is a no-op', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const runId = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});
		await t.mutation(api.systemUpdates.recordUpdateFinish, { runId, status: 'success' });

		expect(await t.query(api.systemUpdates.getUnfinishedUpdate, {})).toBeNull();
	});

	it('ignores an older run left open by a browser that was closed mid-update', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const abandoned = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.0',
			versionTo: '0.5.2',
		});
		const newest = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});
		await t.mutation(api.systemUpdates.recordUpdateFinish, { runId: newest, status: 'success' });

		// The newest run is closed, so there is nothing this poller can speak
		// for — the abandoned one ended in a way nobody here witnessed.
		expect(await t.query(api.systemUpdates.getUnfinishedUpdate, {})).toBeNull();
		const stale = await t.run(async (ctx) => ctx.db.get(abandoned));
		expect(stale?.status).toBe('superseded');
	});

	it('does not mistake the release-check singleton for a run', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		await t.run(async (ctx) =>
			ctx.db.insert('systemUpdates', {
				kind: 'latestCheck',
				latestVersion: '0.5.3',
				checkedAt: Date.now(),
			})
		);

		expect(await t.query(api.systemUpdates.getUnfinishedUpdate, {})).toBeNull();
	});
});

/**
 * ONE RUN AT A TIME.
 *
 * The history table showed two rows reading `running` at once — the update to
 * 0.5.3 and the update to 0.5.4 — on an instance where both rollouts had in
 * fact completed. Neither was live: the happy path orphans its own row (the
 * rollout recreates the container that would close it), and the browser that
 * could close it had moved on. Dispatching a new update now retires whatever
 * is still open before opening its own row.
 */
describe('one update run at a time', () => {
	it('retires the open run when the next update is dispatched', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);

		const orphaned = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});
		const current = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.3',
			versionTo: '0.5.4',
		});

		const retired = await t.run(async (ctx) => ctx.db.get(orphaned));
		expect(retired).toMatchObject({
			status: 'superseded',
			error: 'Superseded by the update to 0.5.4',
		});
		// Left unset on purpose: nobody witnessed that rollout end, and a "now"
		// here would bill the gap between two updates to the first one's duration.
		expect(retired?.finishedAt).toBeUndefined();

		const open = await t.run(async (ctx) => ctx.db.get(current));
		expect(open?.status).toBe('running');
	});

	it('leaves at most one running row however many updates were orphaned', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);

		for (const [versionFrom, versionTo] of [
			['0.5.0', '0.5.2'],
			['0.5.2', '0.5.3'],
			['0.5.3', '0.5.4'],
			['0.5.4', '0.5.5'],
		]) {
			await t.mutation(api.systemUpdates.recordUpdateStart, {
				versionFrom: versionFrom!,
				versionTo: versionTo!,
			});
		}

		const history = await t.query(api.systemUpdates.listUpdateHistory, {});
		expect(history.filter((row) => row.status === 'running')).toHaveLength(1);
		// Newest first, so the survivor is the update actually under way.
		expect(history[0]).toMatchObject({ versionTo: '0.5.5', status: 'running' });
		expect(history.filter((row) => row.status === 'superseded')).toHaveLength(3);
	});

	it('does not retire runs that already ended', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);

		const succeeded = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});
		await t.mutation(api.systemUpdates.recordUpdateFinish, {
			runId: succeeded,
			status: 'success',
		});

		await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.3',
			versionTo: '0.5.4',
		});

		const closed = await t.run(async (ctx) => ctx.db.get(succeeded));
		expect(closed?.status).toBe('success');
		expect(closed?.error).toBeUndefined();
	});

	it('does not touch the release-check singleton, which has no status at all', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const checkId = await t.run(async (ctx) =>
			ctx.db.insert('systemUpdates', {
				kind: 'latestCheck',
				latestVersion: '0.5.4',
				checkedAt: Date.now(),
			})
		);

		await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.3',
			versionTo: '0.5.4',
		});

		const check = await t.run(async (ctx) => ctx.db.get(checkId));
		expect(check).toMatchObject({ kind: 'latestCheck', latestVersion: '0.5.4' });
		expect(check?.status).toBeUndefined();
	});

	it('keeps a superseded verdict when the old route finally reports back', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);

		const orphaned = await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.2',
			versionTo: '0.5.3',
		});
		await t.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '0.5.3',
			versionTo: '0.5.4',
		});

		// The 0.5.3 rollout's route survived after all and closes its own row —
		// a verdict about a rollout this instance has already moved past.
		await t.mutation(api.systemUpdates.recordUpdateFinish, {
			runId: orphaned,
			status: 'success',
			steps: SIDECAR_STEPS,
		});

		const retired = await t.run(async (ctx) => ctx.db.get(orphaned));
		expect(retired?.status).toBe('superseded');
		expect(retired?.steps).toBeUndefined();
	});
});

/**
 * An update the updater refused to start (another rollout held it: 409, or its
 * rate limit: 429) changed nothing. It was recorded as a failed update, and
 * opening its row had retired the rollout that was really running.
 */
describe('systemUpdates.withdrawUpdateStart', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function start(t: ReturnType<typeof convexTest>, versionFrom: string, versionTo: string) {
		vi.advanceTimersByTime(60_000);
		return await t.mutation(api.systemUpdates.recordUpdateStart, { versionFrom, versionTo });
	}

	it('removes the refused run and puts back the rollout it retired', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const live = await start(t, '0.5.3', '0.5.4');
		const refused = await start(t, '0.5.3', '0.5.4');

		await t.mutation(api.systemUpdates.withdrawUpdateStart, { runId: refused });

		const history = await t.query(api.systemUpdates.listUpdateHistory, {});
		expect(history.map((row) => [row._id, row.status, row.error])).toEqual([
			[live, 'running', undefined],
		]);
		// The live rollout's own verdict still lands.
		await t.mutation(api.systemUpdates.recordUpdateFinish, { runId: live, status: 'success' });
		expect((await t.run(async (ctx) => ctx.db.get(live)))?.status).toBe('success');
	});

	it('does not revive a run an earlier update retired', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const orphaned = await start(t, '0.5.2', '0.5.4');
		const failed = await start(t, '0.5.2', '0.5.4');
		await t.mutation(api.systemUpdates.recordUpdateFinish, { runId: failed, status: 'failed' });
		const refused = await start(t, '0.5.2', '0.5.4');

		await t.mutation(api.systemUpdates.withdrawUpdateStart, { runId: refused });

		const history = await t.query(api.systemUpdates.listUpdateHistory, {});
		expect(history.map((row) => [row._id, row.status])).toEqual([
			[failed, 'failed'],
			[orphaned, 'superseded'],
		]);
	});

	it('leaves a run that already has a verdict alone', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const run = await start(t, '0.5.3', '0.5.4');
		await t.mutation(api.systemUpdates.recordUpdateFinish, { runId: run, status: 'success' });

		await t.mutation(api.systemUpdates.withdrawUpdateStart, { runId: run });

		expect((await t.run(async (ctx) => ctx.db.get(run)))?.status).toBe('success');
	});

	it('rejects a caller with no platformAdmins row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t);
		const run = await start(t, '0.5.3', '0.5.4');
		setCaller('org-owner-not-admin');

		await expect(t.mutation(api.systemUpdates.withdrawUpdateStart, { runId: run })).rejects.toThrow(
			/Platform admin access required/
		);
		expect((await t.run(async (ctx) => ctx.db.get(run)))?.status).toBe('running');
	});
});
