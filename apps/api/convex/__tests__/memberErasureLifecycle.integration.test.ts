import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, components, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { MEMBER_ERASURE_PHASES } from '../auth/erasure/phaseCatalog';
import { DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT } from '../delivery/checklistAlertRecipients';
import { seedDeliverabilityAlertRecipients } from './gdprAccountFixtures';
import {
	DAY,
	type Harness,
	drainScheduled,
	erasureHarness,
	jobOf,
	killScheduledWork,
	requestOf,
	runDeletionCron,
	draftRow,
	seedEditor,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Issue #940: account deletion as a persisted, resumable member erasure.
 *
 * The profile used to go first and the rest of the erasure lived only in a
 * scheduled function's arguments; the next daily run took the missing profile
 * as proof of completion. Here the subject and progress live on a job row
 * created in the same transaction, a dead chain is restarted instead of
 * declared done, and `completed` follows an end-state check.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function mailboxGone(t: Harness, mailboxId: string, messageId: string) {
	return await t.run(async (ctx) => {
		const mailbox = await ctx.db.get(mailboxId as never);
		const message = await ctx.db.get(messageId as never);
		return mailbox === null && message === null;
	});
}

/** A row in most phases, so a crash anywhere leaves real work behind. */
async function seedDataAcrossPhases(t: Harness, authUserId: string, mailboxId: Id<'mailboxes'>) {
	await seedDeliverabilityAlertRecipients(t, authUserId, 1);
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailDrafts', draftRow(mailboxId, now));
		const conversationId = await ctx.db.insert('aiConversations', {
			ownerId: authUserId,
			title: 'private',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 1,
		});
		await ctx.db.insert('aiMessages', {
			conversationId,
			ownerId: authUserId,
			role: 'user',
			text: 'my private question',
			status: 'complete',
			createdAt: now,
		});
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel' as const,
			name: 'general',
			normalizedName: 'general',
			visibility: 'public' as const,
			createdBy: 'someone-else',
			lastMessageAt: now,
			messageCount: 1,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('chatRoomMembers', {
			roomId,
			memberId: authUserId,
			role: 'member' as const,
			joinedAt: now,
			lastReadAt: now,
		});
		const messageId = await ctx.db.insert('chatMessages', {
			roomId,
			authorId: authUserId,
			text: 'hello team',
			createdAt: now,
		});
		await ctx.db.insert('chatMentions', {
			roomId,
			messageId,
			mentionedMemberId: authUserId,
			mentioningMemberId: 'someone-else',
			createdAt: now,
		});
	});
}

describe('account deletion handoff', () => {
	it('records the subject and starts the job in the transaction that deletes the profile', async () => {
		const t = erasureHarness();
		const { authUserId, profileId, requestId } = await seedEditor(t);

		const result = await runDeletionCron(t);
		expect(result.processedCount).toBe(1);

		const request = await requestOf(t, requestId);
		expect(request?.status).toBe('erasing');
		expect(request?.authUserId).toBe(authUserId);
		expect(request?.erasureStartedAt).toBeTypeOf('number');
		const job = await jobOf(t, requestId);
		expect(job).toMatchObject({ authUserId, status: 'running', phase: MEMBER_ERASURE_PHASES[0] });
		expect(await t.run((ctx) => ctx.db.get(profileId))).toBeNull();
	});

	it('does not complete a request whose erasure chain died, and resumes it', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const { mailboxId, messageId } = await seedPersonalMailbox(t, authUserId);

		await runDeletionCron(t);
		// The scheduled first step is lost (a permanently failed or interrupted hop).
		await killScheduledWork(t);

		// The next daily run used to see the missing profile and mark it completed.
		await runDeletionCron(t);
		expect((await requestOf(t, requestId))?.status).toBe('erasing');
		expect(await mailboxGone(t, mailboxId, messageId)).toBe(false);

		// Once the job has been quiet long enough, the daily run restarts it.
		vi.advanceTimersByTime(DAY);
		const restarted = await runDeletionCron(t);
		expect(restarted.restartedCount).toBe(1);
		await drainScheduled(t);

		expect((await requestOf(t, requestId))?.status).toBe('completed');
		expect(await mailboxGone(t, mailboxId, messageId)).toBe(true);
		expect(await jobOf(t, requestId)).toBeNull();
	});

	it('resumes after a crash between any two phases without a false completion', async () => {
		for (const stopAt of MEMBER_ERASURE_PHASES) {
			const t = erasureHarness();
			const { authUserId, requestId } = await seedEditor(t);
			const { mailboxId, messageId } = await seedPersonalMailbox(t, authUserId);
			await seedDataAcrossPhases(t, authUserId, mailboxId);
			await runDeletionCron(t);
			const job = (await jobOf(t, requestId))!;
			await killScheduledWork(t);

			// Every phase commits on its own: walk to `stopAt`, then crash there.
			for (let i = 0; i < 200; i++) {
				if ((await jobOf(t, requestId))?.phase === stopAt) break;
				await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
			}
			expect((await jobOf(t, requestId))?.phase).toBe(stopAt);
			await killScheduledWork(t);
			expect((await requestOf(t, requestId))?.status, `stopped at ${stopAt}`).toBe('erasing');

			// A daily run before the job counts as stalled leaves it alone ...
			await runDeletionCron(t);
			expect((await requestOf(t, requestId))?.status).toBe('erasing');
			// ... and the one after restarts it from where it stopped.
			vi.advanceTimersByTime(DAY);
			await runDeletionCron(t);
			await drainScheduled(t);
			expect((await requestOf(t, requestId))?.status, `resumed from ${stopAt}`).toBe('completed');
			expect(await mailboxGone(t, mailboxId, messageId)).toBe(true);
			await t.run(async (ctx) => {
				expect(await ctx.db.query('aiConversations').collect()).toHaveLength(0);
				expect(await ctx.db.query('mailDrafts').collect()).toHaveLength(0);
				expect(await ctx.db.query('chatMentions').collect()).toHaveLength(0);
				const chat = await ctx.db.query('chatMessages').collect();
				expect(chat.map((m) => m.authorId)).toEqual(['[deleted account]']);
			});
		}
	});

	it('keeps the in-flight hop of the previous release working', async () => {
		const t = erasureHarness();
		const { authUserId, profileId, requestId } = await seedEditor(t);
		const { mailboxId, messageId } = await seedPersonalMailbox(t, authUserId);
		// The previous release deleted the profile and scheduled this hop.
		await t.run((ctx) => ctx.db.delete(profileId));
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId,
			requestId,
			isAlertErasureDone: true,
		});
		expect((await requestOf(t, requestId))?.status).toBe('erasing');
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		expect(await mailboxGone(t, mailboxId, messageId)).toBe(true);
	});
});

describe('cancellation', () => {
	it('cancels a request while it is pending', async () => {
		const t = erasureHarness();
		const { requestId } = await seedEditor(t);
		await t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
			userId: '',
			cancellationToken: (await requestOf(t, requestId))!.cancellationToken,
		});
		expect((await requestOf(t, requestId))?.status).toBe('cancelled');
		await runDeletionCron(t);
		expect(await jobOf(t, requestId)).toBeNull();
	});

	it('refuses to cancel once the erasure has begun, and the erasure completes', async () => {
		const t = erasureHarness();
		const { requestId } = await seedEditor(t);
		await runDeletionCron(t);
		const token = (await requestOf(t, requestId))!.cancellationToken;

		await expect(
			t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
				userId: '',
				cancellationToken: token,
			})
		).rejects.toThrow(/already started/);
		expect((await requestOf(t, requestId))?.status).toBe('erasing');

		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
	});
});

describe('failure and recovery', () => {
	it('retries a failing phase, surfaces the error, and the daily run re-arms it', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		// A notification ledger over its bounded size makes the alert phase
		// throw on every attempt: a permanent failure, not a platform hiccup.
		await seedDeliverabilityAlertRecipients(t, authUserId, 1);
		const extraIds = await t.run(async (ctx) => {
			const recipient = await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.first();
			const ids = [];
			for (let i = 0; i <= DELIVERABILITY_ALERT_RECIPIENT_ROW_LIMIT; i++) {
				ids.push(
					await ctx.db.insert('deliverabilityAlertRecipients', {
						organizationId: 'org-x',
						alertId: recipient!.alertId,
						userId: `other-${i}`,
						status: 'sent',
						attemptCount: 1,
						sentAt: Date.now(),
					})
				);
			}
			return ids;
		});

		await runDeletionCron(t);
		await drainScheduled(t);

		const failed = await requestOf(t, requestId);
		expect(failed?.status).toBe('failed');
		expect(failed?.lastError).toMatch(/bounded limit/);
		const status = await t.query(internal.auth.erasure.lifecycle.status, { requestId });
		expect(status?.job).toMatchObject({ status: 'failed', phase: 'alertRecipients', attempts: 5 });
		expect(status?.job?.lastError).toMatch(/bounded limit/);

		// Fixed by an operator; the next daily run re-arms the job.
		await t.run(async (ctx) => {
			for (const id of extraIds) await ctx.db.delete(id);
		});
		vi.advanceTimersByTime(DAY);
		const rerun = await runDeletionCron(t);
		expect(rerun.restartedCount).toBe(1);
		expect((await requestOf(t, requestId))?.status).toBe('erasing');
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
	});

	it('an operator can retry a failed request at once', async () => {
		const t = erasureHarness();
		const { requestId } = await seedEditor(t);
		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;
		await killScheduledWork(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(job._id, { status: 'failed', lastError: 'boom' });
			await ctx.db.patch(requestId, { status: 'failed', lastError: 'boom' });
		});
		expect(await t.mutation(internal.auth.erasure.lifecycle.retry, { requestId })).toBe(
			'restarted'
		);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
	});

	it('restarts the walk when the end-state check finds a row written back', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;
		await killScheduledWork(t);
		// Walk to the last phase, then let a racing writer put a row back
		// behind the walk.
		for (let i = 0; i < 100; i++) {
			const current = await jobOf(t, requestId);
			if (!current || current.phase === MEMBER_ERASURE_PHASES[MEMBER_ERASURE_PHASES.length - 1])
				break;
			await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
		}
		await t.run((ctx) =>
			ctx.db.insert('aiConversations', {
				ownerId: authUserId,
				title: 'late',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastMessageAt: Date.now(),
				messageCount: 0,
			})
		);
		expect(await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id })).toBe('more');
		const again = await jobOf(t, requestId);
		expect(again).toMatchObject({ phase: MEMBER_ERASURE_PHASES[0], verificationPasses: 1 });
		expect((await requestOf(t, requestId))?.status).toBe('erasing');

		await killScheduledWork(t);
		for (let i = 0; i < 100; i++) {
			const outcome = await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
			if (outcome === 'done') break;
		}
		expect((await requestOf(t, requestId))?.status).toBe('completed');
	});
});

describe('requests from before erasures were persisted', () => {
	it('recovers the subject of a due request whose profile is already gone', async () => {
		const t = erasureHarness();
		const { authUserId, profileId, requestId } = await seedEditor(t);
		const { mailboxId, messageId } = await seedPersonalMailbox(t, authUserId);
		// The old handoff: profile and membership gone, chain lost.
		await t.run((ctx) => ctx.db.delete(profileId));
		await t.mutation(internal.auth.accountDeletion.processPendingDeletions, {});
		// Nothing was completed on the strength of the missing profile ...
		expect((await requestOf(t, requestId))?.status).not.toBe('completed');
		await drainScheduled(t);
		// ... and here the member is still a member, so the subject is not
		// recoverable with confidence: the request is failed, not completed.
		const request = await requestOf(t, requestId);
		expect(request?.status).toBe('failed');
		expect(request?.lastError).toMatch(/still a member/);
		expect(await mailboxGone(t, mailboxId, messageId)).toBe(false);
	});

	it('resumes when exactly one identity with the address predates the request', async () => {
		const t = erasureHarness();
		const { authUserId, organizationId, profileId, requestId } = await seedEditor(t);
		const { mailboxId, messageId } = await seedPersonalMailbox(t, authUserId);
		await t.run((ctx) => ctx.db.delete(profileId));
		await t.mutation(components.betterAuth.adapter.deleteOne, {
			input: {
				model: 'member',
				where: [
					{ field: 'organizationId', value: organizationId },
					{ field: 'userId', value: authUserId },
				],
			},
		} as never);

		const result = await runDeletionCron(t);
		expect(result.failedCount).toBe(0);
		expect((await requestOf(t, requestId))?.authUserId).toBe(authUserId);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		expect(await mailboxGone(t, mailboxId, messageId)).toBe(true);
	});
});
