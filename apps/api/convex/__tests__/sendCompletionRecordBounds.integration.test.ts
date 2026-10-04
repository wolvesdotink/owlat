/**
 * The whole completion record is bounded, operator closure keeps parked
 * provider feedback, and the erasure walker charges what it really reads
 * (#1195).
 *
 * Runs with convex-test's real transaction limits. Every listing and deletion
 * path is sized on a record of at most `RECORD_MAX_BYTES`, so no string the
 * worker or a provider hands over may grow a record past it; and the walker's
 * byte budget only holds if a delete's re-read is charged too.
 */

import { convexTest } from 'convex-test';
import { getConvexSize, type Value } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { advanceErasure } from '../contacts/erasure/phases';
import { ErasureBudget } from '../contacts/erasure/budget';
import { RECORD_MAX_BYTES } from '../delivery/sendCompletionPayload';
import {
	acceptedCompletion,
	DAY,
	expiredDeferral,
	failureRows,
	setupQueuedSend,
	type T,
} from './helpers/sendCompletionFailures';
import type * as EffectsModule from '../delivery/sendLifecycle/effects';

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
const MiB = 1024 * 1024;

beforeEach(() => {
	fault.isArmed = false;
});

function harness(limits: true | { bytesRead: number } = true): T {
	return convexTest({ schema, modules, transactionLimits: limits }) as T;
}

const sendOf = (t: T, sendId: Id<'emailSends'>) => t.run((ctx) => ctx.db.get(sendId));

describe('the record size bound', () => {
	it('keeps an oversized provider type off the record and the Send', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'id-ok', { providerType: 'p'.repeat(200 * 1024) })
		);
		const [row] = await failureRows(t);
		expect(row).toMatchObject({
			status: 'exhausted',
			lastError: 'PAYLOAD_TOO_LARGE',
			providerMessageId: 'id-ok',
		});
		expect(row?.providerType).toBeUndefined();
		expect(getConvexSize(row as unknown as Value)).toBeLessThanOrEqual(RECORD_MAX_BYTES);
		expect(await sendOf(t, sendId)).toMatchObject({ providerMessageId: 'id-ok' });
		expect((await sendOf(t, sendId))?.providerType).toBeUndefined();
	});

	it('never stores a truncated provider id; the operator can only close it as failed', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'i'.repeat(200 * 1024))
		);
		fault.isArmed = false;
		const [row] = await failureRows(t);
		expect(row).toMatchObject({ status: 'exhausted', lastError: 'PAYLOAD_TOO_LARGE' });
		expect(row?.providerMessageId).toBeUndefined();
		expect(getConvexSize(row as unknown as Value)).toBeLessThanOrEqual(RECORD_MAX_BYTES);
		expect((await sendOf(t, sendId))?.providerMessageId).toBeUndefined();

		const close = internal.delivery.sendCompletionFailureAdmin.closeCompletionFailure;
		expect(await t.mutation(close, { failureId: row!._id, outcome: 'sent' })).toEqual({
			closed: false,
			reason: 'no_provider_message_id',
		});
		expect(await t.mutation(close, { failureId: row!._id, outcome: 'failed' })).toEqual({
			closed: true,
			reason: null,
		});
		expect((await sendOf(t, sendId))?.errorCode).toBe('SEND_COMPLETION_UNRECOVERABLE');
	});

	it('purges 50 records of oversized outcomes inside the read limit', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		for (let i = 0; i < 50; i++) {
			await t.mutation(
				internal.delivery.sendCompletion.completeSend,
				acceptedCompletion(sendId, 'i'.repeat(200 * 1024), {
					providerType: 'p'.repeat(200 * 1024),
					workId: `oversized-${i}`,
				})
			);
		}
		fault.isArmed = false;
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('sendCompletionFailures').collect()) {
				await ctx.db.patch(row._id, { lastFailedAt: Date.now() - 91 * DAY });
			}
		});
		await t.mutation(internal.delivery.sendCompletionFailureAdmin.purgeCompletionFailures, {});
		await t.finishAllScheduledFunctions(() => {});
		expect(await failureRows(t)).toHaveLength(0);
	});

	it('keeps a record with every parked slot full of maximal text under the bound', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'm'.repeat(512), { providerType: 'plugin.x.y' })
		);
		const at = Date.now();
		const huge = '\u{1F600}'.repeat(100_000);
		const webhook = internal.delivery.sendLifecycle.transitionByProviderMessageId;
		const id = 'm'.repeat(512);
		await t.mutation(webhook, {
			providerMessageId: id,
			transition: { to: 'bounced', at, bounceType: 'soft', bounceMessage: huge },
		});
		await t.mutation(webhook, {
			providerMessageId: id,
			transition: { to: 'bounced', at: at + 1, bounceType: 'hard', bounceMessage: huge },
		});
		await t.mutation(webhook, {
			providerMessageId: id,
			transition: { to: 'complained', at: at + 3 },
		});
		const [row] = await failureRows(t);
		// Bounces and complaints park against `queued`; a provider failure and an
		// attributable delivery are edges the lifecycle takes from `queued` itself.
		expect(row?.pendingFeedback).toHaveLength(3);
		for (const { transition } of row?.pendingFeedback ?? []) {
			if (transition.to !== 'bounced') continue;
			expect(new TextEncoder().encode(transition.bounceMessage ?? '').length).toBeLessThanOrEqual(
				400
			);
		}
		expect(getConvexSize(row as unknown as Value)).toBeLessThanOrEqual(4 * 1024);
	});
});

describe('operator closure and parked feedback', () => {
	it('applies a parked hard bounce after closing as sent', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		const email = (await sendOf(t, sendId))!.contactEmail;
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'op-1')
		);
		await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: 'op-1',
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});
		fault.isArmed = false;
		const [row] = await failureRows(t);

		expect(
			await t.mutation(internal.delivery.sendCompletionFailureAdmin.closeCompletionFailure, {
				failureId: row!._id,
				outcome: 'sent',
			})
		).toEqual({ closed: true, reason: null });
		expect((await sendOf(t, sendId))?.status).toBe('bounced');
		const blocked = await t.run((ctx) =>
			ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.first()
		);
		expect(blocked).not.toBeNull();
		expect((await failureRows(t))[0]).toMatchObject({ status: 'resolved' });
		expect((await failureRows(t))[0]?.pendingFeedback).toBeUndefined();
	});

	it('keeps parked feedback as refusals after closing as failed', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'op-2')
		);
		const at = Date.now();
		await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: 'op-2',
			transition: { to: 'bounced', at, bounceType: 'hard' },
		});
		fault.isArmed = false;
		const [row] = await failureRows(t);

		await t.mutation(internal.delivery.sendCompletionFailureAdmin.closeCompletionFailure, {
			failureId: row!._id,
			outcome: 'failed',
		});
		expect((await sendOf(t, sendId))?.status).toBe('failed');
		expect((await failureRows(t))[0]?.feedbackRefusals).toEqual([
			{ to: 'bounced', at, reason: expect.any(String) },
		]);
	});
});

describe('erasure walker read accounting', () => {
	it('stays inside its 4 MiB budget counting delete re-reads', async () => {
		// 150 records whose payloads are about 31 KiB each (a long idempotency
		// key, which the compact form keeps). Before the re-reads were charged,
		// a 4 MiB budget read about 6 MiB.
		const t = harness({ bytesRead: 4.5 * MiB });
		const { sendId } = await setupQueuedSend(t);
		const send = (await sendOf(t, sendId))!;
		fault.isArmed = true;
		for (let i = 0; i < 150; i++) {
			const args = expiredDeferral(
				sendId,
				send.contactId,
				send.contactEmail,
				`walk-${i}` as WorkId
			);
			args.result.returnValue.retryState.idempotencyKey = 'k'.repeat(31_000);
			await t.mutation(internal.delivery.sendCompletion.completeSend, args);
		}
		fault.isArmed = false;

		let position = { phase: 'sendCompletionFailures' as const } as Parameters<
			typeof advanceErasure
		>[2];
		for (let tick = 0; tick < 50; tick++) {
			const result = await t.run((ctx) =>
				advanceErasure(ctx, send.contactId, position, new ErasureBudget(400, 4 * MiB), 'walker')
			);
			if (result.isComplete) break;
			position = result;
		}
		expect(await failureRows(t)).toHaveLength(0);
	});
});
