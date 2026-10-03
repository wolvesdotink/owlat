/**
 * A send completion that throws keeps its outcome (#1195).
 *
 * The workpool keeps nothing of an `onComplete` that throws, and the worker's
 * result is the only copy of a direct provider's message id. These tests make
 * the Send lifecycle throw inside the completion, the way #1184 did in
 * production, and pin what survives: the provider id on the queued Send, a
 * `sendCompletionFailures` row holding the outcome, a replay that moves the Send
 * exactly once, and the sweep that ends a queued Send no completion reached.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import { REPLAY_MAX_ATTEMPTS } from '../delivery/sendCompletionFailures';
import { STUCK_SEND_AGE_MS, STUCK_SEND_ERROR_CODE } from '../delivery/stuckSendSweep';
import type * as EffectsModule from '../delivery/sendLifecycle/effects';

// The fault: every lifecycle effect run throws while armed, as the activity
// write's validator error did for every `sent` transition in #1184.
const fault = vi.hoisted(() => ({ isArmed: false }));
vi.mock('../delivery/sendLifecycle/effects', async (importOriginal) => {
	const original = await importOriginal<typeof EffectsModule>();
	return {
		...original,
		applyEffects: async (...args: Parameters<typeof original.applyEffects>) => {
			if (fault.isArmed) throw new Error('simulated lifecycle effect failure');
			return await original.applyEffects(...args);
		},
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = TestConvex<typeof schema>;

beforeEach(() => {
	fault.isArmed = false;
});
afterEach(() => {
	vi.useRealTimers();
});

function acceptedCompletion(
	sendId: Id<'emailSends'>,
	providerMessageId: string,
	options: { workId?: string; isCustodyHandoff?: boolean; providerType?: string } = {}
) {
	return {
		workId: (options.workId ?? `work-${sendId}`) as WorkId,
		result: {
			kind: 'success' as const,
			returnValue: {
				kind: 'accepted',
				providerMessageId,
				providerType: options.providerType ?? 'ses',
				sendLatencyMs: 12,
				isCustodyHandoff: options.isCustodyHandoff ?? false,
			},
		},
		context: { sendRef: { kind: 'campaign' as const, id: sendId } },
	};
}

async function setupQueuedSend(
	t: T,
	overrides: Record<string, unknown> = {}
): Promise<{ campaignId: Id<'campaigns'>; sendId: Id<'emailSends'> }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'queued',
				providerMessageId: undefined,
				...overrides,
			})
		);
		return { campaignId, sendId };
	});
}

async function failureRows(t: T) {
	return await t.run(async (ctx) => await ctx.db.query('sendCompletionFailures').collect());
}

async function statsSent(t: T, campaignId: Id<'campaigns'>): Promise<number> {
	return await t.run(async (ctx) => {
		const shards = await ctx.db
			.query('campaignStatShards')
			.withIndex('by_campaign_and_shard', (q) => q.eq('campaignId', campaignId))
			.collect();
		return shards.reduce((sum, shard) => sum + (shard.statsSent ?? 0), 0);
	});
}

describe('completeSend when the lifecycle throws', () => {
	it('keeps the provider id on the queued Send and records the outcome', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);

		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-1')
		);

		const send = await t.run((ctx) => ctx.db.get(sendId));
		expect(send).toMatchObject({
			status: 'queued',
			providerMessageId: 'ses-1',
			providerType: 'ses',
		});
		const [row, ...rest] = await failureRows(t);
		expect(rest).toHaveLength(0);
		expect(row).toMatchObject({
			sendRef: { kind: 'campaign', id: sendId },
			status: 'open',
			outcomeKind: 'accepted',
			providerMessageId: 'ses-1',
			replayAttempts: 0,
			lastError: expect.stringContaining('simulated lifecycle effect failure'),
		});
		expect(row?.result).toMatchObject({ kind: 'success', returnValue: { kind: 'accepted' } });
	});

	it('lets a bounce webhook resolve the Send and land once the fault is gone', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-2')
		);

		const bounce = {
			providerMessageId: 'ses-2',
			transition: { to: 'bounced' as const, at: Date.now(), bounceType: 'hard' as const },
		};
		// Still faulty: the webhook finds the Send, the replay fails again and
		// spends no cron attempt, and the record stays open.
		const early = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			bounce
		);
		expect(early).not.toEqual({ ok: false, reason: 'send_not_found' });
		expect((await failureRows(t))[0]).toMatchObject({ status: 'open', replayAttempts: 0 });

		fault.isArmed = false;
		const late = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			bounce
		);
		expect(late).toMatchObject({ ok: true, from: 'sent', to: 'bounced' });
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('bounced');
		expect(await statsSent(t, campaignId)).toBe(1);
		expect((await failureRows(t))[0]).toMatchObject({
			status: 'resolved',
			resolution: 'replayed',
		});
		expect((await failureRows(t))[0]?.result).toBeUndefined();
	});

	it('records an MTA identity conflict instead of losing it', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t, {
			providerMessageId: 'mta-bound',
			providerType: 'mta',
		});

		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'mta-other', { isCustodyHandoff: true, providerType: 'mta' })
		);

		expect(await t.run((ctx) => ctx.db.get(sendId))).toMatchObject({
			status: 'queued',
			providerMessageId: 'mta-bound',
		});
		expect((await failureRows(t))[0]).toMatchObject({
			status: 'open',
			providerMessageId: 'mta-other',
			lastError: expect.stringContaining('conflicts with the Send provider identity'),
		});
	});

	it('keeps one record when the workpool runs the same completion twice', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		const completion = acceptedCompletion(sendId, 'ses-dup');
		await t.mutation(internal.delivery.sendCompletion.completeSend, completion);
		await t.mutation(internal.delivery.sendCompletion.completeSend, completion);
		expect(await failureRows(t)).toHaveLength(1);
	});
});

describe('replaying a recorded completion', () => {
	it('moves the Send to sent exactly once after the fault is fixed', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		const completion = acceptedCompletion(sendId, 'ses-3');
		await t.mutation(internal.delivery.sendCompletion.completeSend, completion);
		const failureId = (await failureRows(t))[0]!._id;

		fault.isArmed = false;
		const replay = internal.delivery.sendCompletionFailures.replayCompletionFailure;
		expect(await t.mutation(replay, { failureId })).toBe('replayed');
		expect(await t.mutation(replay, { failureId })).toBe('skipped');
		// A late duplicate `onComplete` for the same work changes nothing either.
		await t.mutation(internal.delivery.sendCompletion.completeSend, completion);

		expect(await t.run((ctx) => ctx.db.get(sendId))).toMatchObject({
			status: 'sent',
			providerMessageId: 'ses-3',
		});
		expect(await statsSent(t, campaignId)).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(campaignId)))?.status).toBe('sent');
		expect(await failureRows(t)).toHaveLength(1);
	});

	it('resolves without replaying when a webhook already moved the Send', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-4')
		);
		const failureId = (await failureRows(t))[0]!._id;
		fault.isArmed = false;
		// Something else settled the Send first (here: the lifecycle directly).
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'ses-4' },
		});

		expect(
			await t.mutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
				failureId,
			})
		).toBe('superseded');
		expect(await statsSent(t, campaignId)).toBe(1);
	});

	it('backs off on the cron, stops at the cap, and re-opens for an operator', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-5')
		);
		const failureId = (await failureRows(t))[0]!._id;
		const replay = internal.delivery.sendCompletionFailures.replayCompletionFailure;

		// Not due yet: the cron leaves it alone.
		expect(await t.mutation(replay, { failureId, trigger: 'cron' })).toBe('skipped');
		for (let attempt = 1; attempt <= REPLAY_MAX_ATTEMPTS; attempt += 1) {
			vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
			expect(await t.mutation(replay, { failureId, trigger: 'cron' })).toBe('failed');
		}
		expect((await failureRows(t))[0]).toMatchObject({
			status: 'exhausted',
			replayAttempts: REPLAY_MAX_ATTEMPTS,
		});
		vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
		expect(await t.mutation(replay, { failureId, trigger: 'cron' })).toBe('skipped');

		const status = await t.query(internal.delivery.sendCompletionFailures.status, {});
		expect(status).toMatchObject({ open: 0, exhausted: 1 });
		expect(status.sample[0]).toMatchObject({ sendId, providerMessageId: 'ses-5' });

		fault.isArmed = false;
		await t.mutation(
			internal.delivery.sendCompletionFailures.reopenExhaustedCompletionFailures,
			{}
		);
		const scheduled = await t.mutation(
			internal.delivery.sendCompletionFailures.replayDueCompletionFailures,
			{}
		);
		expect(scheduled).toEqual({ scheduled: 1 });
		await t.finishAllScheduledFunctions(() => {});
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('sent');
		expect((await failureRows(t))[0]).toMatchObject({ status: 'resolved' });
	});
});

describe('stuck queued Send sweep', () => {
	it('ends a queued Send with no provider id past the deadline so its campaign completes', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = convexTest(schema, modules);
		const stuck = await setupQueuedSend(t);
		const waiting = await setupQueuedSend(t, { providerMessageId: 'ses-waiting' });

		vi.setSystemTime(Date.now() + STUCK_SEND_AGE_MS - 60_000);
		const young = await setupQueuedSend(t);
		vi.setSystemTime(Date.now() + 2 * 60_000);

		await t.mutation(internal.delivery.stuckSendSweep.sweepStuckQueuedSends, {});
		await t.finishAllScheduledFunctions(() => {});

		expect(await t.run((ctx) => ctx.db.get(stuck.sendId))).toMatchObject({
			status: 'failed',
			errorCode: STUCK_SEND_ERROR_CODE,
		});
		expect((await t.run((ctx) => ctx.db.get(stuck.campaignId)))?.status).toBe('sent');
		expect((await t.run((ctx) => ctx.db.get(waiting.sendId)))?.status).toBe('queued');
		expect((await t.run((ctx) => ctx.db.get(young.sendId)))?.status).toBe('queued');
	});
});
