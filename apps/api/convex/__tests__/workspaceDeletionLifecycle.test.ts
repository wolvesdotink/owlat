/**
 * The workspace deletion lifecycle (#898): one durable job per generation, a
 * write fence that holds while it runs, a checkpoint the recovery driver
 * resumes from, and completion only once every registered table is verified
 * empty.
 *
 * Everything runs through the real `settings.remove`, the real walker and the
 * real producers; only the session resolution is mocked, as an owner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { STEPS, ORGANIZATION_DELETION_STEPS } from '../workspaces/deletion/steps/registry';
import { MAX_VERIFY_PASSES } from '../workspaces/deletion/job';
import { FAILED_DELETION_RETRY_AFTER_MS } from '../workspaces/deletion/walker';
import { fenceWorkspaceWrites } from '../lib/writeFence';
import { createTestContact } from './factories';
import { newHarness } from './testModules';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const owner = { userId: 'owner-user', role: 'owner', activeOrganizationId: 'org' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(owner),
		getMutationContext: vi.fn().mockResolvedValue(owner),
		requireOrgPermission: vi.fn().mockResolvedValue(owner),
	};
});

type Harness = ReturnType<typeof newHarness>;
type JobId = Id<'workspaceDeletionJobs'>;

// Scheduled work (the drive chain the job schedules, retries) never fires on
// its own: each test moves the job one transaction at a time.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const REFUSED = { data: { category: 'invalid_state' } };

async function job(t: Harness, jobId: JobId) {
	const row = await t.run(async (ctx) => ctx.db.get(jobId));
	if (!row) throw new Error('job row missing');
	return row;
}

async function startDeletion(t: Harness): Promise<JobId> {
	await t.mutation(api.workspaces.settings.remove, {});
	const status = await t.query(internal.workspaces.deletion.walker.status, {});
	if (!status) throw new Error('remove() opened no job');
	return status.jobId;
}

const tick = (t: Harness, jobId: JobId) =>
	t.mutation(internal.workspaces.deletion.walker.tick, { jobId });

/** Tick until `until` holds for the job row (or the job stops moving). */
async function tickUntil(
	t: Harness,
	jobId: JobId,
	until: (row: Awaited<ReturnType<typeof job>>) => boolean
): Promise<void> {
	for (let i = 0; i < STEPS.length * 3; i++) {
		if (until(await job(t, jobId))) return;
		if ((await tick(t, jobId)) !== 'more') return;
	}
	throw new Error('the job never reached the expected state');
}

const pastStep = (table: string) => (row: { phase: string; step: string }) =>
	row.phase === 'verify' || STEPS.indexOf(row.step as never) > STEPS.indexOf(table as never);

async function runToCompletion(t: Harness, jobId: JobId): Promise<void> {
	await tickUntil(t, jobId, (row) => !row.isActive);
}

describe('workspace deletion — the write fence', () => {
	it('refuses a contact created after the contacts step, and no row survives', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact());
		});
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, pastStep('contacts'));

		await expect(
			t.mutation(api.contacts.contacts.create, { email: 'review@example.com' })
		).rejects.toMatchObject(REFUSED);

		await runToCompletion(t, jobId);
		expect((await job(t, jobId)).status).toBe('completed');
		expect(await t.run(async (ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);

		// Completion is what lifts the fence: the empty workspace takes writes again.
		await t.mutation(internal.contacts.contacts.createForTeam, { email: 'after@example.com' });
		expect(await t.run(async (ctx) => ctx.db.query('contacts').collect())).toHaveLength(1);
	});

	it('refuses API-key and incoming service-event writes while the deletion runs', async () => {
		const t = newHarness();
		await startDeletion(t);

		await expect(
			t.mutation(internal.contacts.contacts.createForTeam, { email: 'api@example.com' })
		).rejects.toMatchObject(REFUSED);
		await expect(
			t.mutation(internal.webhooks.payloads.store, { source: 'ses', rawPayload: '{}' })
		).rejects.toMatchObject(REFUSED);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('contacts').collect()).toHaveLength(0);
			expect(await ctx.db.query('webhookPayloads').collect()).toHaveLength(0);
		});
	});

	it("refuses the commit of an action that runs past the deletion's start", async () => {
		const t = newHarness();
		await startDeletion(t);

		// The health rollup reads, then commits its window through a mutation.
		await expect(t.action(internal.agentHealth.rollupMetrics, {})).rejects.toMatchObject(REFUSED);
		expect(await t.run(async (ctx) => ctx.db.query('agentMetrics').collect())).toHaveLength(0);
	});

	it('closes only the swept tables, and lets deletes through', async () => {
		const t = newHarness();
		const { contactId, profileId } = await t.run(async (ctx) => ({
			contactId: await ctx.db.insert('contacts', createTestContact()),
			profileId: await ctx.db.insert('userProfiles', {
				authUserId: 'member',
				email: 'member@example.com',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		}));
		await startDeletion(t);

		await t.run(async (raw) => {
			const ctx = fenceWorkspaceWrites(raw);
			// Auth identity is not swept: sign-in paths keep writing it.
			await ctx.db.patch(profileId, { updatedAt: Date.now() });
			await expect(ctx.db.patch(contactId, { firstName: 'Late' })).rejects.toMatchObject(REFUSED);
			await expect(
				ctx.db.patch('contacts', contactId, { firstName: 'Late' })
			).rejects.toMatchObject(REFUSED);
			await expect(ctx.db.insert('contacts', createTestContact())).rejects.toMatchObject(REFUSED);
			await ctx.db.delete(contactId);
		});
		expect(await t.run(async (ctx) => ctx.db.get(contactId))).toBeNull();
	});
});

describe('workspace deletion — one job per generation', () => {
	it('joins concurrent removal requests into a single generation', async () => {
		const t = newHarness();
		const outcomes = await Promise.all([
			t.mutation(api.workspaces.settings.remove, {}),
			t.mutation(api.workspaces.settings.remove, {}),
		]);

		expect(outcomes.map((o) => o.generation)).toEqual([1, 1]);
		expect(outcomes.filter((o) => o.isJoined)).toHaveLength(1);
		const rows = await t.run(async (ctx) => ctx.db.query('workspaceDeletionJobs').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ generation: 1, isActive: true, joinedRequests: 1 });

		// Once it has completed, a new request is the next generation.
		await runToCompletion(t, rows[0]!._id);
		const next = await t.mutation(api.workspaces.settings.remove, {});
		expect(next).toMatchObject({ generation: 2, isJoined: false });
	});

	it("adopts a previous release's in-flight hop into a job at its next table", async () => {
		const t = newHarness();
		await t.mutation(internal.workspaces.deletion.walker.runStep, { table: 'segments' });
		const status = await t.query(internal.workspaces.deletion.walker.status, {});
		expect(status).toMatchObject({
			source: 'previous_release',
			phase: 'sweep',
			step: STEPS[STEPS.indexOf('segments') + 1],
			isActive: true,
		});
	});
});

describe('workspace deletion — checkpoint and recovery', () => {
	it('resumes a failed step from the saved checkpoint after the recovery driver re-arms it', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			for (const name of ['a', 'b']) {
				await ctx.db.insert('segments', {
					name,
					filters: { conditions: [], logic: 'AND' as const },
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, (row) => row.step === 'segments');

		const failing = vi
			.spyOn(ORGANIZATION_DELETION_STEPS.segments, 'deleteBatch')
			.mockRejectedValue(new Error('injected segments failure'));
		// Every retry fails too, until the job gives up.
		for (let attempt = 1; attempt <= 5; attempt++) {
			await t.action(internal.workspaces.deletion.walker.drive, { jobId });
		}
		const failed = await job(t, jobId);
		expect(failed).toMatchObject({
			status: 'failed',
			isActive: true,
			step: 'segments',
			lastErrorStep: 'segments',
			attempts: 5,
		});
		expect(failed.lastError).toContain('injected segments failure');
		// The fence stays up while the job is failed.
		await expect(
			t.mutation(internal.contacts.contacts.createForTeam, { email: 'late@example.com' })
		).rejects.toMatchObject(REFUSED);

		// A row written behind the checkpoint (an earlier table) by a writer the
		// fence cannot see, to tell a resume from a restart.
		await t.run(async (ctx) => {
			await ctx.db.insert('topics', { name: 'Behind', createdAt: Date.now() });
		});

		failing.mockRestore();
		expect(await t.mutation(internal.workspaces.deletion.walker.recover, {})).toEqual({
			isRestarted: false,
		});
		vi.setSystemTime(Date.now() + FAILED_DELETION_RETRY_AFTER_MS);
		expect(await t.mutation(internal.workspaces.deletion.walker.recover, {})).toEqual({
			isRestarted: true,
		});

		const before = await job(t, jobId);
		expect(before).toMatchObject({ status: 'running', attempts: 0, step: 'segments' });
		await tick(t, jobId);
		const resumed = await job(t, jobId);
		expect(resumed.step).toBe(STEPS[STEPS.indexOf('segments') + 1]);
		expect(resumed.rowsDeleted).toBe(before.rowsDeleted + 2);
		// Resumed at the checkpoint, not from the first table: the earlier row waits
		// for the verification pass.
		expect(await t.run(async (ctx) => ctx.db.query('topics').collect())).toHaveLength(1);

		await runToCompletion(t, jobId);
		expect(await job(t, jobId)).toMatchObject({ status: 'completed', verifyPasses: 2 });
		expect(await t.run(async (ctx) => ctx.db.query('topics').collect())).toHaveLength(0);
	});
});

describe('workspace deletion — completion invariant', () => {
	it('re-sweeps a table the verification finds rows in, and only then completes', async () => {
		const t = newHarness();
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, (row) => row.phase === 'verify');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact());
		});
		await tick(t, jobId);
		const resweep = await job(t, jobId);
		expect(resweep).toMatchObject({
			isActive: true,
			status: 'running',
			phase: 'sweep',
			step: 'contacts',
			verifyPasses: 1,
		});
		expect(resweep.completedAt).toBeUndefined();

		await runToCompletion(t, jobId);
		expect(await job(t, jobId)).toMatchObject({ status: 'completed', verifyPasses: 2 });
		expect(await t.run(async (ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
	});

	it('fails loudly, fence still up, when rows keep reappearing', async () => {
		const t = newHarness();
		const jobId = await startDeletion(t);
		for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
			await tickUntil(t, jobId, (row) => row.phase === 'verify');
			await t.run(async (ctx) => {
				await ctx.db.insert('instanceSettings', { createdAt: Date.now() });
			});
			await tick(t, jobId);
		}
		expect(await job(t, jobId)).toMatchObject({
			status: 'failed',
			isActive: true,
			lastErrorStep: 'instanceSettings',
			verifyPasses: MAX_VERIFY_PASSES,
		});
	});
});
