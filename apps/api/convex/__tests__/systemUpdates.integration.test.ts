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
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
		expect(stale?.status).toBe('running');
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
