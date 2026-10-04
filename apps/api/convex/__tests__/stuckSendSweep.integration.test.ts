/**
 * The lost-send sweep and the first-attempt record it reads (#1208).
 *
 * A Send no completion ever reached stays `queued` with no provider id, and its
 * campaign stays `sending`. The sweep may fail it only once nothing can still
 * settle it: its recorded first attempt is past the four-day delivery deadline
 * plus a day. These tests pin where that record comes from
 * (`routingReentry.issueSnapshot`, once per Send), that delayed and deferred
 * Sends keep their whole window, that lost ones are failed with
 * `SEND_COMPLETION_LOST`, that rows without the record are left to an operator,
 * and that each pass reads one bounded page per transaction.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { DAY, type T } from './helpers/sendCompletionFailures';
import {
	at,
	drainSweep,
	getSend,
	holdLease,
	HOUR,
	queuedCampaignSend,
	queuedTransactionalSend,
	runCron,
	T0,
} from './helpers/stuckSendSweep';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import {
	LOST_SEND_ERROR_CODE,
	SWEEP_PAGE_SIZE,
	UNANCHORED_MIN_AGE_MS,
} from '../delivery/stuckSendSweep';
import type * as EffectsModule from '../delivery/sendLifecycle/effects';

const enqueueAction = vi.fn().mockResolvedValue('work-1');
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction },
	transactionalEmailPool: { enqueueAction },
}));

// A lifecycle effect run that throws for one chosen Send, the #1184 fault.
const fault = vi.hoisted(() => ({ campaignId: null as string | null }));
vi.mock('../delivery/sendLifecycle/effects', async (importOriginal) => {
	const original = await importOriginal<typeof EffectsModule>();
	return {
		...original,
		applyEffects: async (...args: Parameters<typeof original.applyEffects>) => {
			const isTarget = args[1].some(
				(effect) => 'campaignId' in effect && effect.campaignId === fault.campaignId
			);
			if (fault.campaignId !== null && isTarget) {
				throw new Error('simulated lifecycle effect failure');
			}
			return await original.applyEffects(...args);
		},
	};
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
	vi.stubEnv('INSTANCE_SECRET', 'stuck-send-sweep-test-secret-at-least-32-characters');
	fault.campaignId = null;
	enqueueAction.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

/** One governed attempt passing the dispatch boundary, as the worker does it. */
async function attempt(
	t: T,
	sendId: Id<'emailSends'>,
	startedAt: number,
	attemptNumber = 1
): Promise<void> {
	await t.mutation(internal.delivery.routingReentry.issueSnapshot, {
		sendRef: { kind: 'campaign', id: sendId },
		organizationId: 'org-1',
		messageId: `send_${sendId}`,
		workAttemptId: `attempt-${attemptNumber}`,
		envelopeInput: {
			kind: 'campaign',
			to: 'person@example.com',
			from: 'sender@example.org',
			template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
			contactInfo: { email: 'person@example.com' },
			emailSendId: sendId,
			organizationId: 'org-1',
		},
		retryState: { attempt: attemptNumber, startedAt, idempotencyKey: `send_${sendId}` },
	});
}

describe('the first-attempt record', () => {
	it('is written by the first governed attempt and not moved by its retries', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t);
		expect((await getSend(t, sendId))?.firstAttemptAt).toBeUndefined();

		const firstAttemptAt = T0 + 2 * DAY;
		at(firstAttemptAt);
		await attempt(t, sendId, firstAttemptAt, 1);
		expect((await getSend(t, sendId))?.firstAttemptAt).toBe(firstAttemptAt);

		// A deferral retry and a routing re-entry carry the same start.
		at(firstAttemptAt + 3 * DAY);
		await attempt(t, sendId, firstAttemptAt, 2);
		await attempt(t, sendId, firstAttemptAt, 3);
		expect((await getSend(t, sendId))?.firstAttemptAt).toBe(firstAttemptAt);
	});

	it('never moves back to an earlier start, and follows a fresh attempt chain forward', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t);
		at(T0 + DAY);
		await attempt(t, sendId, T0 + DAY);
		await attempt(t, sendId, T0 + HOUR, 2);
		expect((await getSend(t, sendId))?.firstAttemptAt).toBe(T0 + DAY);

		at(T0 + 2 * DAY);
		await attempt(t, sendId, T0 + 2 * DAY);
		expect((await getSend(t, sendId))?.firstAttemptAt).toBe(T0 + 2 * DAY);
	});

	it('is written for a transactional Send too', async () => {
		const t = convexTest(schema, modules);
		const sendId = await queuedTransactionalSend(t);
		await t.mutation(internal.delivery.routingReentry.issueSnapshot, {
			sendRef: { kind: 'transactional', id: sendId },
			organizationId: 'org-1',
			messageId: `send_${sendId}`,
			workAttemptId: 'attempt-1',
			envelopeInput: {
				kind: 'transactional',
				emailPurpose: 'transactional',
				to: 'person@example.com',
				from: 'sender@example.org',
				sendId,
				template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
				organizationId: 'org-1',
			},
			retryState: { attempt: 1, startedAt: T0, idempotencyKey: `send_${sendId}` },
		});
		expect((await getSend(t, sendId))?.firstAttemptAt).toBe(T0);
	});
});

describe('the cron sweep', () => {
	it('keeps a deferred Send through its delivery window and the grace, then fails it', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await queuedCampaignSend(t);
		await attempt(t, sendId, T0);

		// Deferred retries run until the deadline; then a day of grace.
		at(T0 + 4 * DAY - HOUR);
		await attempt(t, sendId, T0, 5);
		at(T0 + 5 * DAY - 1);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');

		at(T0 + 5 * DAY + 1);
		await runCron(t);
		const send = await getSend(t, sendId);
		expect(send).toMatchObject({ status: 'failed', errorCode: LOST_SEND_ERROR_CODE });

		await t.mutation(internal.campaigns.lifecycle.reconcileSendingCampaigns, {});
		const campaign = await t.run(async (ctx) => await ctx.db.get(campaignId));
		expect(campaign?.status).toBe('sent');
	});

	it('counts from the first attempt, not from queueing (send-time optimization)', async () => {
		// The #1207 review case: queued on day 0, first attempted on day 2,
		// still legitimately deferred on day 5.
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t);
		at(T0 + 2 * DAY);
		await attempt(t, sendId, T0 + 2 * DAY);
		at(T0 + 5 * DAY);
		await attempt(t, sendId, T0 + 2 * DAY, 4);

		at(T0 + 6 * DAY);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');
		at(T0 + 7 * DAY - 1);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');

		at(T0 + 7 * DAY + 1);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('failed');
	});

	it('fails a lost transactional Send', async () => {
		const t = convexTest(schema, modules);
		const sendId = await queuedTransactionalSend(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(sendId, { firstAttemptAt: T0 });
		});
		at(T0 + 6 * DAY);
		await runCron(t);
		expect(await getSend(t, sendId)).toMatchObject({
			status: 'failed',
			errorCode: LOST_SEND_ERROR_CODE,
		});
	});

	it('leaves a Send with a provider id (MTA custody, a stamped acceptance)', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t, {
			providerMessageId: 'send_mta-custody',
			providerType: 'mta',
			firstAttemptAt: T0,
		});
		at(T0 + 30 * DAY);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');
	});

	it('leaves a Send whose completion failure is still open to that record', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t, { firstAttemptAt: T0 });
		await t.run(async (ctx) => {
			await ctx.db.insert('sendCompletionFailures', {
				sendRef: { kind: 'campaign', id: sendId },
				workId: 'work-open',
				status: 'exhausted',
				outcomeKind: 'deferred',
				lastError: 'UNKNOWN',
				replayAttempts: 10,
				firstFailedAt: T0,
				lastFailedAt: T0,
			});
		});
		at(T0 + 30 * DAY);
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');

		const status = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
			kind: 'campaign',
			range: 'due',
		});
		expect(status).toMatchObject({ counted: 1, isDone: true });
		expect(status.sample[0]).toMatchObject({
			sendId,
			hasOpenCompletionFailure: true,
			sweepableAt: T0 + 5 * DAY,
		});
	});

	it('leaves rows without a first-attempt record (legacy, or never attempted)', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t);
		at(T0 + 60 * DAY);
		// The deadline range does not even read it (an absent field sorts first).
		const due = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
			kind: 'campaign',
			range: 'due',
		});
		expect(due.counted).toBe(0);
		const unanchored = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
			kind: 'campaign',
			range: 'unanchored',
		});
		expect(unanchored).toMatchObject({ counted: 1, pastMinimumAge: 1 });
		await runCron(t);
		expect((await getSend(t, sendId))?.status).toBe('queued');
	});

	it('reads one bounded page per transaction and passes over rows it skips', async () => {
		const t = convexTest(schema, modules);
		// The oldest anchors are rows the sweep must skip (an open record each),
		// so a pass that re-read from the start would never reach the rest.
		const skipped: Id<'emailSends'>[] = [];
		for (let i = 0; i < SWEEP_PAGE_SIZE + 5; i++) {
			const { sendId } = await queuedCampaignSend(t, { firstAttemptAt: T0 + i });
			skipped.push(sendId);
			await t.run(async (ctx) => {
				await ctx.db.insert('sendCompletionFailures', {
					sendRef: { kind: 'campaign', id: sendId },
					workId: `work-${i}`,
					status: 'open',
					outcomeKind: 'accepted',
					lastError: 'UNKNOWN',
					replayAttempts: 0,
					firstFailedAt: T0,
					lastFailedAt: T0,
				});
			});
		}
		const lost: Id<'emailSends'>[] = [];
		for (let i = 0; i < SWEEP_PAGE_SIZE + 10; i++) {
			lost.push((await queuedCampaignSend(t, { firstAttemptAt: T0 + 1000 + i })).sendId);
		}
		// Not due yet: first attempted inside the window.
		const live = (await queuedCampaignSend(t, { firstAttemptAt: T0 + 5 * DAY })).sendId;

		at(T0 + 6 * DAY);
		await holdLease(t, 'emailSends:deadline', 1, T0 + 6 * DAY);
		const first = await t.mutation(internal.delivery.stuckSendSweep.sweepLostSendPage, {
			table: 'emailSends',
			mode: 'deadline',
			cutoff: T0 + DAY,
			cursor: null,
			generation: 1,
		});
		// The first page is all records waiting for an operator: no call for any.
		expect(first).toMatchObject({ scheduled: 0, skipped: SWEEP_PAGE_SIZE, isDone: false });

		await runCron(t);
		for (const id of lost) expect((await getSend(t, id))?.status).toBe('failed');
		for (const id of skipped) expect((await getSend(t, id))?.status).toBe('queued');
		expect((await getSend(t, live))?.status).toBe('queued');
	});

	it('fails the other Sends of a page when one throws, and retries it next pass', async () => {
		const t = convexTest(schema, modules);
		const bad = await queuedCampaignSend(t, { firstAttemptAt: T0 });
		const good = await queuedCampaignSend(t, { firstAttemptAt: T0 + 1 });
		fault.campaignId = bad.campaignId;
		// The bad Send's own scheduled `failLostSend` throws and rolls back.
		expectScheduledFailure('delivery/stuckSendSweep:failLostSend');
		at(T0 + 6 * DAY);
		await runCron(t);
		expect((await getSend(t, bad.sendId))?.status).toBe('queued');
		expect((await getSend(t, good.sendId))?.status).toBe('failed');

		fault.campaignId = null;
		await runCron(t);
		expect((await getSend(t, bad.sendId))?.status).toBe('failed');
	});
});

describe('the operator pass for rows without a first-attempt record', () => {
	it('refuses a cutoff younger than the minimum age', async () => {
		const t = convexTest(schema, modules);
		at(T0 + 30 * DAY);
		await expect(
			t.mutation(internal.delivery.stuckSendSweepAdmin.failUnanchoredLostSends, {
				createdBefore: T0 + 30 * DAY - UNANCHORED_MIN_AGE_MS + 1,
			})
		).rejects.toThrow(/days in the past/u);
	});

	it('fails old unanchored rows and leaves recent, anchored and provider-id rows', async () => {
		const t = convexTest(schema, modules);
		const legacy = (await queuedCampaignSend(t)).sendId;
		const legacyTransactional = await queuedTransactionalSend(t);
		const withProviderId = (await queuedCampaignSend(t, { providerMessageId: 'ses-1' })).sendId;
		const anchored = (await queuedCampaignSend(t, { firstAttemptAt: T0 + 27 * DAY })).sendId;
		at(T0 + 25 * DAY);
		// Queued five days ago and not attempted yet: a scheduled send waiting.
		const recent = (await queuedCampaignSend(t)).sendId;

		at(T0 + 30 * DAY);
		const before = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
			kind: 'campaign',
			range: 'unanchored',
		});
		expect(before).toMatchObject({ counted: 2, pastMinimumAge: 1 });
		expect(Math.floor(before.sample[0]?.createdAt ?? 0)).toBe(T0);

		await t.mutation(internal.delivery.stuckSendSweepAdmin.failUnanchoredLostSends, {
			createdBefore: T0 + 30 * DAY - UNANCHORED_MIN_AGE_MS,
		});
		await drainSweep(t);

		expect(await getSend(t, legacy)).toMatchObject({
			status: 'failed',
			errorCode: LOST_SEND_ERROR_CODE,
		});
		expect((await getSend(t, legacyTransactional))?.status).toBe('failed');
		expect((await getSend(t, recent))?.status).toBe('queued');
		expect((await getSend(t, withProviderId))?.status).toBe('queued');
		expect((await getSend(t, anchored))?.status).toBe('queued');
	});
});
