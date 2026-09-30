import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { components, internal } from '../_generated/api';
import { recoverErasureSubject } from '../auth/erasure/lifecycle';
import {
	DAY,
	IDENTITY_MODELS,
	type Harness,
	drainScheduled,
	erasureHarness,
	identityRows,
	identityUser,
	jobOf,
	requestOf,
	runDeletionCron,
	seedDueRequest,
	seedEditor,
	seedIdentity,
	seedMembership,
	seedOrganization,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Issue #941: account deletion erases the BetterAuth login identity, not only
 * the Owlat profile. Before, a completed deletion left the `user` row (name,
 * email), the password hash, live sessions, passkeys and the TOTP secret in
 * the component, and the address stayed registered.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function create(t: Harness, model: string, data: Record<string, unknown>) {
	return (await t.mutation(components.betterAuth.adapter.create, {
		input: { model, data },
	} as never)) as { _id: string };
}

async function findAll(t: Harness, model: string, field: string, value: string) {
	return (
		(await t.query(components.betterAuth.adapter.findMany, {
			model,
			where: [{ field, value }],
			paginationOpts: { cursor: null, numItems: 1000 },
		} as never)) as { page: Array<Record<string, unknown>> }
	).page;
}

async function expectIdentityGone(t: Harness, userId: string) {
	expect(await identityUser(t, userId)).toBeNull();
	for (const model of IDENTITY_MODELS) {
		expect(await identityRows(t, model, userId), model).toHaveLength(0);
	}
}

describe('editor account deletion', () => {
	it('removes the user, credentials, sessions, passkeys and TOTP secret', async () => {
		const t = erasureHarness();
		const email = 'editor@example.com';
		const { organizationId, authUserId, requestId } = await seedEditor(t, email);
		// A colleague who stays, with an identity of their own.
		const colleagueId = await seedIdentity(t, 'colleague@example.com');
		await seedMembership(t, organizationId, colleagueId, 'admin');
		const now = Date.now();
		// A live password-reset token for the member, and one for the colleague.
		await create(t, 'verification', {
			identifier: 'reset-password:token-a',
			value: authUserId,
			expiresAt: now + DAY,
			createdAt: now,
			updatedAt: now,
		});
		await create(t, 'verification', {
			identifier: 'reset-password:token-b',
			value: colleagueId,
			expiresAt: now + DAY,
			createdAt: now,
			updatedAt: now,
		});
		// The member's own accepted invitation, a pending re-invite, and one the
		// member sent to someone else.
		const invite = (status: string, to: string, inviterId: string) =>
			create(t, 'invitation', {
				organizationId,
				email: to,
				role: 'editor',
				status,
				expiresAt: now + DAY,
				inviterId,
			});
		await invite('accepted', email, colleagueId);
		await invite('pending', email, colleagueId);
		await invite('pending', 'newcomer@example.com', authUserId);

		await runDeletionCron(t);
		await drainScheduled(t);

		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await expectIdentityGone(t, authUserId);
		expect(await findAll(t, 'user', 'email', email)).toHaveLength(0);
		const verifications = await findAll(t, 'verification', 'identifier', 'reset-password:token-a');
		expect(verifications).toHaveLength(0);
		expect(await findAll(t, 'verification', 'identifier', 'reset-password:token-b')).toHaveLength(
			1
		);
		const invitations = await findAll(t, 'invitation', 'organizationId', organizationId);
		expect(invitations.map((i) => `${i['email']}:${i['status']}`).sort()).toEqual([
			'editor@example.com:pending',
			'newcomer@example.com:pending',
		]);

		// The colleague and the organization are untouched.
		expect(await identityUser(t, colleagueId)).not.toBeNull();
		for (const model of ['session', 'account', 'passkey', 'twoFactor', 'member']) {
			expect(await identityRows(t, model, colleagueId), model).toHaveLength(1);
		}
		expect(await findAll(t, 'organization', '_id', organizationId)).toHaveLength(1);
	});

	it('makes existing sessions unusable in the transaction that starts the erasure', async () => {
		const t = erasureHarness();
		const { authUserId } = await seedEditor(t);
		await runDeletionCron(t);
		// No erasure step has run yet. BetterAuth resolves a session by joining
		// its user (`findSession` returns null without one), and every sign-in
		// path starts by finding the user: both end here.
		expect(await identityUser(t, authUserId)).toBeNull();
		expect(await identityRows(t, 'session', authUserId)).toHaveLength(1);
		await drainScheduled(t);
		expect(await identityRows(t, 'session', authUserId)).toHaveLength(0);
	});

	it('drains a long session history over bounded transactions', async () => {
		const t = erasureHarness(true);
		const organizationId = await seedOrganization(t);
		const email = 'busy@example.com';
		const authUserId = await seedIdentity(t, email, { sessions: 900 });
		await seedMembership(t, organizationId, authUserId, 'editor');
		const { requestId } = await seedDueRequest(t, authUserId, email);

		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;
		let sessionTransactions = 0;
		for (let i = 0; i < 200; i++) {
			const current = await jobOf(t, requestId);
			if (!current) break;
			if (current.phase === 'authSessions') sessionTransactions++;
			await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
		}
		expect(sessionTransactions).toBeGreaterThan(1);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await expectIdentityGone(t, authUserId);
	});

	it('recovers from a limit hit in the identity phases without a false completion', async () => {
		// A transaction of either phase that hits a platform limit is retried a
		// row at a time, and the request stays `erasing` throughout.
		const t = erasureHarness();
		const organizationId = await seedOrganization(t);
		const email = 'limits@example.com';
		const authUserId = await seedIdentity(t, email, { sessions: 120 });
		for (let i = 0; i < 120; i++) {
			await create(t, 'passkey', {
				publicKey: 'pk',
				userId: authUserId,
				credentialID: `extra-${i}`,
				counter: 0,
				deviceType: 'singleDevice',
				backedUp: false,
			});
		}
		await seedMembership(t, organizationId, authUserId, 'editor');
		const { requestId } = await seedDueRequest(t, authUserId, email);
		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;

		// A limit error from the platform, as `drive` would record it.
		const limitError = 'Too many documents written in a single function execution (limit: 16000).';
		for (const phase of ['authSessions', 'authCredentials'] as const) {
			await t.run((ctx) => ctx.db.patch(job._id, { phase }));
			await t.mutation(internal.auth.erasure.walker.recordFailure, {
				jobId: job._id,
				error: limitError,
			});
			const failed = await jobOf(t, requestId);
			expect(failed).toMatchObject({ status: 'retrying', rowCap: 1, attempts: 1 });
			expect((await requestOf(t, requestId))?.status).toBe('erasing');
			// One row per transaction, doubling as each one commits.
			await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
			expect((await jobOf(t, requestId))?.rowCap).toBe(2);
		}
		await t.run((ctx) => ctx.db.patch(job._id, { phase: 'authSessions' }));
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await expectIdentityGone(t, authUserId);
	});
});

describe('owner account deletion', () => {
	it('erases the identity and completes only after the workspace sweep', async () => {
		const t = erasureHarness();
		const organizationId = await seedOrganization(t);
		const email = 'owner@example.com';
		const authUserId = await seedIdentity(t, email);
		await seedMembership(t, organizationId, authUserId, 'owner');
		const { requestId } = await seedDueRequest(t, authUserId, email);
		await seedPersonalMailbox(t, authUserId);

		await runDeletionCron(t);
		// The workspace deletion is running: the job erases the identity and the
		// instance-level rows, then waits for the sweep.
		for (let i = 0; i < 20; i++) {
			const job = await jobOf(t, requestId);
			if (!job || job.isWaitingForWorkspaceDeletion) break;
			await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
		}
		const waiting = await jobOf(t, requestId);
		expect(waiting).toMatchObject({
			phase: 'externalAccounts',
			isWaitingForWorkspaceDeletion: true,
		});
		expect((await requestOf(t, requestId))?.status).toBe('erasing');
		await expectIdentityGone(t, authUserId);

		await drainScheduled(t, 5000);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		expect(await findAll(t, 'organization', '_id', organizationId)).toHaveLength(0);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailboxes').collect()).toHaveLength(0);
			expect(await ctx.db.query('memberErasureJobs').collect()).toHaveLength(0);
		});
	});
});

describe('the address afterwards', () => {
	it('can be registered again without inheriting anything', async () => {
		const t = erasureHarness();
		const email = 'again@example.com';
		const { authUserId, requestId } = await seedEditor(t, email);
		await t.run((ctx) =>
			ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-1',
				inviteeEmail: email,
				organizationId: 'org-x',
				localpart: 'again',
				domain: 'example.com',
				address: 'again@example.com',
				createdAt: Date.now(),
				createdByUserId: 'admin-1',
				acceptedByUserId: authUserId,
			})
		);
		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		// The old reservation would have provisioned a mailbox for the erased id.
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pendingMailboxes').collect()).toHaveLength(0);
		});

		// The address is free: nothing in the identity store claims it.
		expect(await findAll(t, 'user', 'email', email)).toHaveLength(0);
		vi.advanceTimersByTime(DAY);
		const newcomerId = await seedIdentity(t, email, { createdAt: Date.now() });
		expect(newcomerId).not.toBe(authUserId);
		// A legacy re-erasure never mistakes the newcomer for the erased person.
		const request = (await requestOf(t, requestId))!;
		const recovery = await t.run((ctx) =>
			recoverErasureSubject(ctx, { ...request, authUserId: undefined })
		);
		expect(recovery).toEqual({
			ok: false,
			reason: 'The identity with the address was created after the request.',
		});
	});

	it('the 0051 migration re-erases what a legacy completed deletion left behind', async () => {
		const t = erasureHarness();
		const email = 'legacy@example.com';
		const { organizationId, authUserId, profileId, requestId } = await seedEditor(t, email);
		await seedPersonalMailbox(t, authUserId);
		const survivorId = await seedIdentity(t, 'survivor@example.com');
		await seedMembership(t, organizationId, survivorId, 'editor');
		// The old path: profile and membership gone, request completed, identity
		// and mailbox untouched, no subject recorded.
		await t.run(async (ctx) => {
			await ctx.db.delete(profileId);
			await ctx.db.patch(requestId, { status: 'completed', statusChangedAt: Date.now() });
		});
		await t.mutation(components.betterAuth.adapter.deleteOne, {
			input: {
				model: 'member',
				where: [
					{ field: 'organizationId', value: organizationId },
					{ field: 'userId', value: authUserId },
				],
			},
		} as never);

		const result = await t.action(
			internal.migrations['0051_reerase_legacy_account_deletions'].run,
			{}
		);
		expect(result).toEqual({ reopened: 1, skipped: 0 });
		expect((await requestOf(t, requestId))?.status).toBe('erasing');
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await expectIdentityGone(t, authUserId);
		await t.run(async (ctx) => {
			const mailboxes = await ctx.db.query('mailboxes').collect();
			expect(mailboxes).toHaveLength(0);
		});
		expect(await identityUser(t, survivorId)).not.toBeNull();

		// A second run finds nothing left to reopen.
		expect(
			await t.action(internal.migrations['0051_reerase_legacy_account_deletions'].run, {})
		).toEqual({ reopened: 0, skipped: 0 });
	});
});
