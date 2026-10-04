/**
 * A send completion that throws keeps its outcome (#1195).
 *
 * The workpool keeps nothing of an `onComplete` that throws, and the worker's
 * result is the only copy of a direct provider's message id. These tests make
 * the Send lifecycle throw inside the completion, the way #1184 did in
 * production, and pin what survives: the provider id on the queued Send, a
 * `sendCompletionFailures` row holding the outcome, a replay that moves the Send
 * exactly once, a provider event that arrives early and is applied after it,
 * and records that go with an erased contact and age out.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	acceptedCompletion,
	DAY,
	expiredDeferral,
	failureRows,
	payloadRows,
	insertResolvedRecords,
	setupQueuedSend,
	statsSent,
	type T,
} from './helpers/sendCompletionFailures';
import { REPLAY_MAX_ATTEMPTS } from '../delivery/sendCompletionFailures';
import { completionErrorCode } from '../delivery/sendCompletionPayload';
import { PURGE_BATCH_SIZE } from '../delivery/sendCompletionFailureAdmin';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
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

beforeEach(() => {
	fault.isArmed = false;
});
afterEach(() => {
	vi.useRealTimers();
});

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
			lastError: 'UNKNOWN',
		});
		const [payload, ...otherPayloads] = await payloadRows(t);
		expect(otherPayloads).toHaveLength(0);
		expect(payload).toMatchObject({
			failureId: row?._id,
			result: { kind: 'success', returnValue: { kind: 'accepted' } },
		});
	});

	it('keeps an early bounce through a failed replay and applies it once the replay succeeds', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await setupQueuedSend(t);
		const contactEmail = (await t.run((ctx) => ctx.db.get(sendId)))!.contactEmail;
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-2')
		);

		// Still faulty: the webhook finds the Send, its replay fails again and
		// spends no cron attempt, and the lifecycle refuses the bounce against
		// `queued`. The bounce is parked on the record, once, even when the
		// provider delivers it twice.
		const bounce = {
			providerMessageId: 'ses-2',
			transition: { to: 'bounced' as const, at: Date.now(), bounceType: 'hard' as const },
		};
		const early = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			bounce
		);
		expect(early).toMatchObject({ ok: false });
		expect(early).not.toEqual({ ok: false, reason: 'send_not_found' });
		await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, bounce);
		const [parked] = await failureRows(t);
		expect(parked).toMatchObject({ status: 'open', replayAttempts: 0 });
		expect(parked?.pendingFeedback).toHaveLength(1);

		// The fault is fixed and the replay runs. The bounce is never sent again.
		fault.isArmed = false;
		expect(
			await t.mutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
				failureId: parked!._id,
			})
		).toBe('replayed');

		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('bounced');
		expect(await statsSent(t, campaignId)).toBe(1);
		const blocked = await t.run((ctx) =>
			ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', contactEmail))
				.first()
		);
		expect(blocked).not.toBeNull();
		const [resolved] = await failureRows(t);
		expect(resolved).toMatchObject({ status: 'resolved', resolution: 'replayed' });
		expect(await payloadRows(t)).toHaveLength(0);
		expect(resolved?.pendingFeedback).toBeUndefined();
	});

	it('replays the completion before a provider event that arrives after the fix', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'ses-2b')
		);
		fault.isArmed = false;

		const late = await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: 'ses-2b',
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});
		expect(late).toMatchObject({ ok: true, from: 'sent', to: 'bounced' });
		expect(await statsSent(t, campaignId)).toBe(1);
		expect((await failureRows(t))[0]).toMatchObject({ status: 'resolved' });
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
			lastError: 'MTA_IDENTITY_CONFLICT',
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

		const status = await t.query(internal.delivery.sendCompletionFailureAdmin.status, {});
		expect(status).toMatchObject({ open: 0, exhausted: 1 });
		expect(status.sample[0]).toMatchObject({ sendId, providerMessageId: 'ses-5' });

		fault.isArmed = false;
		await t.mutation(
			internal.delivery.sendCompletionFailureAdmin.reopenExhaustedCompletionFailures,
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

describe('contact erasure', () => {
	async function recordDeferralFailure(t: T) {
		const { sendId } = await setupQueuedSend(t);
		const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			expiredDeferral(sendId, send.contactId, send.contactEmail)
		);
		fault.isArmed = false;
		// The stored outcome never holds the envelope: no recipient, no message.
		const stored = JSON.stringify(await payloadRows(t));
		expect(stored).not.toContain(send.contactEmail);
		expect(stored).not.toContain('Private details');
		expect(await failureRows(t)).toHaveLength(1);
		return { sendId, contactId: send.contactId, email: send.contactEmail };
	}

	it('deletes the records of a Send the inline erasure scrubs', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId, email } = await recordDeferralFailure(t);

		await t.run((ctx) =>
			permanentlyDeleteContactWithRelations(ctx, contactId, { decrementCount: false })
		);

		expect((await t.run((ctx) => ctx.db.get(sendId)))?.contactEmail).toBe('[erased]');
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);

		// A late `onComplete` for the erased Send records nothing.
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			expiredDeferral(sendId, contactId, email)
		);
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});

	it('deletes every record of a Send, behind resolved history and across work ids', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
		await insertResolvedRecords(t, sendId, 10);
		fault.isArmed = true;
		for (let i = 0; i < 11; i++) {
			await t.mutation(
				internal.delivery.sendCompletion.completeSend,
				expiredDeferral(sendId, send.contactId, send.contactEmail, `defer-${i}`)
			);
		}
		fault.isArmed = false;
		expect(await failureRows(t)).toHaveLength(21);

		await t.run((ctx) =>
			permanentlyDeleteContactWithRelations(ctx, send.contactId, { decrementCount: false })
		);
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});

	it('deletes the records of a Send the erasure walker scrubs', async () => {
		const t = convexTest(schema, modules);
		const { contactId } = await recordDeferralFailure(t);
		await t.run((ctx) => ctx.db.patch(contactId, { deletedAt: Date.now() - 31 * DAY }));

		await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		const job = await t.run((ctx) =>
			ctx.db
				.query('contactErasureJobs')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first()
		);
		for (let i = 0; i < 20; i++) {
			if ((await t.mutation(internal.contacts.erasure.walker.tick, { jobId: job!._id })) !== 'more')
				break;
		}
		expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});
});

describe('record retention', () => {
	it('drains a purge backlog larger than one batch, keeping recent and open records', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		const now = Date.now();
		const row = (status: 'resolved' | 'exhausted' | 'open', lastFailedAt: number, i: number) => ({
			sendRef: { kind: 'campaign' as const, id: sendId },
			workId: `${status}-${lastFailedAt}-${i}`,
			status,
			outcomeKind: 'accepted',
			lastError: 'old error',
			replayAttempts: 0,
			firstFailedAt: lastFailedAt,
			lastFailedAt,
		});
		await t.run(async (ctx) => {
			for (let i = 0; i < PURGE_BATCH_SIZE + 1; i++) {
				await ctx.db.insert('sendCompletionFailures', row('resolved', now - 31 * DAY, i));
			}
			await ctx.db.insert('sendCompletionFailures', row('exhausted', now - 91 * DAY, 0));
			await ctx.db.insert('sendCompletionFailures', row('exhausted', now - 31 * DAY, 0));
			await ctx.db.insert('sendCompletionFailures', row('resolved', now - DAY, 0));
			await ctx.db.insert('sendCompletionFailures', row('open', now - 91 * DAY, 0));
		});

		await t.mutation(internal.delivery.sendCompletionFailureAdmin.purgeCompletionFailures, {});
		await t.finishAllScheduledFunctions(() => {});

		const left = (await failureRows(t)).map(
			(r) => `${r.status}:${Math.round((now - r.lastFailedAt) / DAY)}`
		);
		expect(left.sort()).toEqual(['exhausted:31', 'open:91', 'resolved:1']);
	});
});

describe('stored error code', () => {
	it('stores a fixed code, never the message text', () => {
		const validation = new Error(
			'Failed to insert or update a document in table "contactActivities" because it does not match the schema: Object {firstName: "Private name", subject: "Private message"}'
		);
		expect(completionErrorCode(validation)).toBe('CONVEX_VALIDATION');
		expect(
			completionErrorCode(
				new Error('Invalid document {firstName:"Private name", htmlContent:"Private message"}')
			)
		).toBe('UNKNOWN');
		expect(completionErrorCode(new TypeError('x of Private name'))).toBe('TYPE_ERROR');
	});
});
