/**
 * The workspace deletion lifecycle (#898): one durable job per generation, a
 * write fence that holds while it runs, a quiet scheduler, a checkpoint the
 * recovery driver resumes from, and completion only once every registered
 * table is verified empty.
 *
 * Everything runs through the real `settings.remove`, the real walker and the
 * real producers; only the session resolution is mocked, as an owner.
 */

import { createHmac } from 'node:crypto';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { STEPS, ORGANIZATION_DELETION_STEPS } from '../workspaces/deletion/steps/registry';
import { MAX_VERIFY_PASSES } from '../workspaces/deletion/job';
import {
	DELETION_STALLED_AFTER_MS,
	FAILED_DELETION_RETRY_AFTER_MS,
	RETRY_DELAYS_MS,
} from '../workspaces/deletion/walker';
import { fenceWorkspaceWrites, isWorkspaceDeletionRefusal } from '../lib/writeFence';
import { InboundBatchDispatchError } from '../webhooks/inboundHttp';
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

const MTA_SECRET = 'mta-test-secret';

// Scheduled work (the drive chain the job schedules, retries) never fires on
// its own: each test moves the job one transaction at a time.
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('MTA_WEBHOOK_SECRET', MTA_SECRET);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const REFUSED = { data: { category: 'invalid_state' } };

async function status(t: Harness) {
	const summary = await t.query(internal.workspaces.deletion.walker.status, {});
	if (!summary) throw new Error('no deletion job');
	return summary;
}
type Summary = Awaited<ReturnType<typeof status>>;

async function startDeletion(t: Harness): Promise<JobId> {
	await t.mutation(api.workspaces.settings.remove, {});
	return (await status(t)).jobId;
}

const tick = (t: Harness, jobId: JobId) =>
	t.mutation(internal.workspaces.deletion.walker.tick, { jobId });

/** Tick until `until` holds for the job (or the job stops moving). */
async function tickUntil(t: Harness, jobId: JobId, until: (s: Summary) => boolean): Promise<void> {
	for (let i = 0; i < STEPS.length * 3; i++) {
		if (until(await status(t))) return;
		if ((await tick(t, jobId)) !== 'more') return;
	}
	throw new Error('the job never reached the expected state');
}

const pastStep = (table: string) => (s: Summary) =>
	s.phase === 'verify' ||
	(s.phase === 'sweep' && STEPS.indexOf(s.step as never) > STEPS.indexOf(table as never));

const runToCompletion = (t: Harness, jobId: JobId) => tickUntil(t, jobId, (s) => !s.isActive);

const contacts = (t: Harness) => t.run(async (ctx) => ctx.db.query('contacts').collect());

/** An HMAC-signed POST from the MTA, as `mail/webhookHttp.ts`'s routes verify it. */
function postFromMta(t: Harness, path: string, body: unknown) {
	const text = JSON.stringify(body);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac('sha256', MTA_SECRET).update(`${timestamp}.${text}`).digest('hex');
	return t.fetch(path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-MTA-Timestamp': timestamp,
			'X-MTA-Signature': signature,
		},
		body: text,
	});
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
		expect((await status(t)).status).toBe('completed');
		expect(await contacts(t)).toHaveLength(0);

		// Completion is what lifts the fence: the empty workspace takes writes again.
		await t.mutation(internal.contacts.contacts.createForTeam, { email: 'after@example.com' });
		expect(await contacts(t)).toHaveLength(1);
	});

	it('refuses an API-key write while the deletion runs', async () => {
		const t = newHarness();
		await startDeletion(t);
		await expect(
			t.mutation(internal.contacts.contacts.createForTeam, { email: 'api@example.com' })
		).rejects.toMatchObject(REFUSED);
		expect(await contacts(t)).toHaveLength(0);
	});

	it('acknowledges and drops inbound mail posted to the MTA route while the deletion runs', async () => {
		const t = newHarness();
		rateLimiterTest.register(t);
		await startDeletion(t);

		const response = await postFromMta(t, '/webhooks/mta-inbound', {
			event: 'inbound.received',
			timestamp: Date.now(),
			inboundPayload: {
				headers: {},
				attachments: [],
				messageId: '<late@example.com>',
				from: 'sender@example.com',
				to: 'team@example.com',
				subject: 'Late mail',
				textBody: 'Hello',
			},
		});

		// A final 2xx, so the MTA neither retries nor parks it in its dead-letter
		// queue for a replay into the emptied workspace.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			ignored: 'workspace_deletion_in_progress',
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('inboundMessages').collect()).toHaveLength(0);
			// The route's raw-body audit write is refused by the fence too.
			expect(await ctx.db.query('webhookPayloads').collect()).toHaveLength(0);
		});
	});

	it('recognises a refusal wrapped by the inbound batch dispatcher', async () => {
		const t = newHarness();
		await startDeletion(t);
		const refusal = await t
			.mutation(internal.webhooks.payloads.store, { source: 'ses', rawPayload: '{}' })
			.then(
				() => null,
				(error: unknown) => error
			);
		expect(isWorkspaceDeletionRefusal(refusal)).toBe(true);
		expect(
			isWorkspaceDeletionRefusal(
				new InboundBatchDispatchError({ kind: 'bounce' } as never, refusal)
			)
		).toBe(true);
		expect(isWorkspaceDeletionRefusal(new Error('something else'))).toBe(false);
	});

	it('refuses the commit of an action that was already in flight when the deletion began', async () => {
		const t = newHarness();
		const { inFlightId, controlId } = await t.run(async (ctx) => ({
			inFlightId: await ctx.db.insert('trackingDomains', {
				domain: 'track.example.com',
				cnameTarget: 'cname.example.com',
				isVerified: false,
				createdAt: Date.now(),
			}),
			controlId: await ctx.db.insert('trackingDomains', {
				domain: 'links.example.com',
				cnameTarget: 'cname.example.com',
				isVerified: false,
				createdAt: Date.now(),
			}),
		}));
		const dnsAnswer = () =>
			new Response(JSON.stringify({ Answer: [{ type: 5, data: 'cname.example.com.' }] }), {
				status: 200,
			});
		const verify = (trackingDomainId: Id<'trackingDomains'>, domain: string) =>
			t.action(internal.domains.trackingDomains.verifyTrackingDomainDns, {
				trackingDomainId,
				domain,
				expectedCname: 'cname.example.com',
			});

		// Control: with no deletion the same action commits.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => dnsAnswer())
		);
		await expect(verify(controlId, 'links.example.com')).resolves.toEqual({ verified: true });

		// The action reaches its DNS lookup, and waits there while the deletion begins.
		let reachedLookup!: () => void;
		const lookupReached = new Promise<void>((resolve) => (reachedLookup = resolve));
		let answerLookup!: (response: Response) => void;
		const lookupAnswer = new Promise<Response>((resolve) => (answerLookup = resolve));
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				reachedLookup();
				return lookupAnswer;
			})
		);
		const inFlight = verify(inFlightId, 'track.example.com');
		await lookupReached;
		await startDeletion(t);
		answerLookup(dnsAnswer());

		// The action's own catch turns the refused commit into a soft failure.
		await expect(inFlight).resolves.toMatchObject({ verified: false });
		expect(await t.run(async (ctx) => (await ctx.db.get(inFlightId))?.isVerified)).toBe(false);
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

	it("closes a non-owner's account deletion that runs during the deletion", async () => {
		const t = newHarness();
		const { requestId, adminId } = await t.run(async (ctx) => {
			const now = Date.now();
			const userProfileId = await ctx.db.insert('userProfiles', {
				authUserId: 'member-2',
				email: 'member-2@example.com',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('userOnboarding', {
				authUserId: 'member-2',
				createdAt: now,
				updatedAt: now,
			});
			return {
				requestId: await ctx.db.insert('accountDeletionRequests', {
					userProfileId,
					email: 'member-2@example.com',
					requestedAt: now,
					scheduledForDeletion: now,
					cancellationToken: 'token',
					status: 'pending',
					createdAt: now,
				}),
				adminId: await ctx.db.insert('platformAdmins', {
					authUserId: 'member-2',
					email: 'member-2@example.com',
					role: 'admin',
					createdAt: now,
				}),
			};
		});
		await startDeletion(t);

		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'member-2',
			requestId,
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(requestId))?.status).toBe('completed');
			// The rows outside the sweep go now; the sweep takes the rest.
			expect(await ctx.db.get(adminId)).toBeNull();
			expect(await ctx.db.query('userOnboarding').collect()).toHaveLength(0);
		});
	});
});

describe('workspace deletion — one job per generation', () => {
	// convex-test runs transactions one at a time, so this exercises the join
	// path, not the race itself. On a deployment the race resolves the same way:
	// both requests read the `by_is_active` range, the first insert conflicts
	// with the second, and OCC re-runs the second into the join.
	it('joins a second removal request into the job in progress', async () => {
		const t = newHarness();
		const outcomes = await Promise.all([
			t.mutation(api.workspaces.settings.remove, {}),
			t.mutation(api.workspaces.settings.remove, {}),
		]);

		expect(outcomes.map((o) => o.generation)).toEqual([1, 1]);
		expect(outcomes.filter((o) => o.isJoined)).toHaveLength(1);
		const jobs = await t.run(async (ctx) => ctx.db.query('workspaceDeletionJobs').collect());
		expect(jobs).toHaveLength(1);
		expect(await status(t)).toMatchObject({ generation: 1, isActive: true, joinedRequests: 1 });

		// Once it has completed, a new request is the next generation.
		await runToCompletion(t, jobs[0]!._id);
		const next = await t.mutation(api.workspaces.settings.remove, {});
		expect(next).toMatchObject({ generation: 2, isJoined: false });
	});

	it("adopts a previous release's in-flight hop into a job at its next table", async () => {
		const t = newHarness();
		await t.mutation(internal.workspaces.deletion.walker.runStep, { table: 'segments' });
		expect(await status(t)).toMatchObject({
			source: 'previous_release',
			phase: 'quiesce',
			step: STEPS[STEPS.indexOf('segments') + 1],
			isActive: true,
		});
	});
});

describe('workspace deletion — the scheduler', () => {
	it("cancels the workspace's pending scheduled work, at the start and again before completion", async () => {
		const t = newHarness();
		const early = await t.run(async (ctx) => ({
			tenant: await ctx.scheduler.runAfter(3_600_000, internal.contacts.contacts.createForTeam, {
				email: 'later@example.com',
			}),
			// Instance plumbing on the survivor list is left alone.
			survivor: await ctx.scheduler.runAfter(
				3_600_000,
				internal.workspaces.deletion.walker.recover,
				{}
			),
		}));
		const jobId = await startDeletion(t);
		const state = (id: Id<'_scheduled_functions'>) =>
			t.run(async (ctx) => (await ctx.db.system.get(id))?.state.kind);

		await tick(t, jobId);
		expect(await state(early.tenant)).toBe('canceled');
		expect(await state(early.survivor)).toBe('pending');
		expect((await status(t)).phase).toBe('sweep');

		// Scheduled after the start (a fenced mutation may schedule without writing).
		const late = await t.run(async (ctx) =>
			ctx.scheduler.runAfter(3_600_000, internal.contacts.contacts.createForTeam, {
				email: 'late@example.com',
			})
		);
		await runToCompletion(t, jobId);
		expect(await state(late)).toBe('canceled');
		expect((await status(t)).scheduledCancelled).toBe(2);
	});
});

describe('workspace deletion — checkpoint and recovery', () => {
	async function seedSegments(t: Harness): Promise<void> {
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
	}

	it('resumes a failed step from the saved checkpoint after the recovery driver re-arms it', async () => {
		const t = newHarness();
		await seedSegments(t);
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, (s) => s.phase === 'sweep' && s.step === 'segments');

		const failing = vi
			.spyOn(ORGANIZATION_DELETION_STEPS.segments, 'deleteBatch')
			.mockRejectedValue(new Error('injected segments failure'));
		// Every retry fails too, until the job gives up.
		for (let attempt = 1; attempt <= 5; attempt++) {
			await t.action(internal.workspaces.deletion.walker.drive, { jobId });
		}
		const failed = await status(t);
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
		const recover = () => t.mutation(internal.workspaces.deletion.walker.recover, {});
		expect(await recover()).toEqual({ isRestarted: false });
		vi.setSystemTime(Date.now() + FAILED_DELETION_RETRY_AFTER_MS);
		expect(await recover()).toEqual({ isRestarted: true });

		const before = await status(t);
		expect(before).toMatchObject({ status: 'running', attempts: 0, step: 'segments', rearms: 1 });
		await tick(t, jobId);
		const resumed = await status(t);
		expect(resumed.step).toBe(STEPS[STEPS.indexOf('segments') + 1]);
		expect(resumed.rowsDeleted).toBe(before.rowsDeleted + 2);
		// Resumed at the checkpoint, not from the first table: the earlier row waits
		// for the verification pass.
		expect(await t.run(async (ctx) => ctx.db.query('topics').collect())).toHaveLength(1);

		await runToCompletion(t, jobId);
		expect(await status(t)).toMatchObject({ status: 'completed', verifyPasses: 1 });
		expect(await t.run(async (ctx) => ctx.db.query('topics').collect())).toHaveLength(0);
	});

	it('leaves a job waiting out its longest retry backoff to that retry', async () => {
		const t = newHarness();
		await seedSegments(t);
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, (s) => s.phase === 'sweep' && s.step === 'segments');
		vi.spyOn(ORGANIZATION_DELETION_STEPS.segments, 'deleteBatch').mockRejectedValue(
			new Error('injected segments failure')
		);
		for (let attempt = 1; attempt <= 4; attempt++) {
			await t.action(internal.workspaces.deletion.walker.drive, { jobId });
		}
		// Four failures: the fourth retry is 30 minutes out.
		expect(await status(t)).toMatchObject({ status: 'retrying', attempts: 4 });
		expect(DELETION_STALLED_AFTER_MS).toBeGreaterThan(Math.max(...RETRY_DELAYS_MS));

		const recover = () => t.mutation(internal.workspaces.deletion.walker.recover, {});
		vi.setSystemTime(Date.now() + 16 * 60 * 1000);
		expect(await recover()).toEqual({ isRestarted: false });
		vi.setSystemTime(Date.now() + DELETION_STALLED_AFTER_MS);
		expect(await recover()).toEqual({ isRestarted: true });
	});
});

describe('workspace deletion — completion invariant', () => {
	it('re-sweeps a table the verification finds rows in, and only then completes', async () => {
		const t = newHarness();
		const jobId = await startDeletion(t);
		await tickUntil(t, jobId, (s) => s.phase === 'verify');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact());
		});
		await tick(t, jobId);
		expect(await status(t)).toMatchObject({
			isActive: true,
			status: 'running',
			phase: 'sweep',
			step: 'contacts',
			verifyPasses: 1,
			endedAt: null,
		});

		await runToCompletion(t, jobId);
		expect(await status(t)).toMatchObject({ status: 'completed', verifyPasses: 1 });
		expect(await contacts(t)).toHaveLength(0);
	});

	it('fails loudly when rows keep reappearing, and completes once re-armed', async () => {
		const t = newHarness();
		const jobId = await startDeletion(t);
		for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
			await tickUntil(t, jobId, (s) => s.phase === 'verify');
			await t.run(async (ctx) => {
				await ctx.db.insert('instanceSettings', { createdAt: Date.now() });
			});
			await tick(t, jobId);
		}
		const failed = await status(t);
		expect(failed).toMatchObject({
			status: 'failed',
			isActive: true,
			phase: 'sweep',
			step: 'instanceSettings',
			lastErrorStep: 'instanceSettings',
			verifyPasses: MAX_VERIFY_PASSES,
		});

		// The writer stops; the recovery driver re-arms the job, which sweeps the
		// table it failed on instead of re-verifying straight into another failure.
		vi.setSystemTime(Date.now() + FAILED_DELETION_RETRY_AFTER_MS);
		expect(await t.mutation(internal.workspaces.deletion.walker.recover, {})).toEqual({
			isRestarted: true,
		});
		expect(await status(t)).toMatchObject({ status: 'running', verifyPasses: 0, rearms: 1 });
		await runToCompletion(t, jobId);
		expect(await status(t)).toMatchObject({ status: 'completed', isActive: false });
		expect(await t.run(async (ctx) => ctx.db.query('instanceSettings').collect())).toHaveLength(0);
	});

	it('lets an operator abort the job, lifting the fence with an audit row', async () => {
		const t = newHarness();
		await startDeletion(t);

		await expect(
			t.mutation(internal.workspaces.deletion.walker.abort, {
				operator: 'ops@example.com',
				reason: 'rows keep reappearing',
			})
		).resolves.toEqual({ generation: 1 });

		expect(await status(t)).toMatchObject({
			isActive: false,
			status: 'aborted',
			abortedBy: 'ops@example.com',
		});
		const audit = await t.run(async (ctx) => ctx.db.query('auditLogs').collect());
		expect(audit).toMatchObject([
			{ action: 'settings.workspace_deletion_aborted', userId: 'ops@example.com' },
		]);
		await t.mutation(internal.contacts.contacts.createForTeam, { email: 'after@example.com' });
		expect(await contacts(t)).toHaveLength(1);
		// Nothing left to abort.
		await expect(
			t.mutation(internal.workspaces.deletion.walker.abort, { operator: 'ops', reason: 'again' })
		).resolves.toBeNull();
	});
});
