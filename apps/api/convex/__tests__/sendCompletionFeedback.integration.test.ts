/**
 * Provider feedback parked on a recorded send completion (#1195).
 *
 * While a Send's completion cannot replay, the Send stays `queued` and the
 * lifecycle refuses terminal feedback against it. These tests pin that such an
 * event is kept and applied after the completion: whichever provider-id entry
 * point it arrives through, however many soft bounces came before it, in the
 * provider's time order, and behind any amount of resolved history.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	acceptedCompletion,
	failureRows,
	insertResolvedRecords,
	setupQueuedSend,
	type T,
} from './helpers/sendCompletionFailures';
import type { Id } from '../_generated/dataModel';
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

beforeEach(() => {
	fault.isArmed = false;
});

/** A completion that throws, leaving one open record; the fault stays armed. */
async function failCompletion(
	t: T,
	sendId: Id<'emailSends'>,
	providerMessageId: string,
	providerType = 'ses'
): Promise<Id<'sendCompletionFailures'>> {
	fault.isArmed = true;
	await t.mutation(
		internal.delivery.sendCompletion.completeSend,
		acceptedCompletion(sendId, providerMessageId, { providerType })
	);
	return (await failureRows(t)).find((row) => row.status === 'open')!._id;
}

async function webhook(
	t: T,
	providerMessageId: string,
	transition:
		| { to: 'bounced'; at: number; bounceType: 'hard' | 'soft' }
		| { to: 'complained' | 'delivered'; at: number }
) {
	return await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
		providerMessageId,
		transition,
	});
}

async function replay(t: T, failureId: Id<'sendCompletionFailures'>) {
	fault.isArmed = false;
	return await t.mutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
		failureId,
	});
}

const sendOf = (t: T, sendId: Id<'emailSends'>) => t.run((ctx) => ctx.db.get(sendId));

describe('parking provider feedback on a recorded completion', () => {
	it('finds the open record behind ten resolved ones', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		await insertResolvedRecords(t, sendId, 10);
		const failureId = await failCompletion(t, sendId, 'hidden');

		await webhook(t, 'hidden', { to: 'bounced', at: Date.now(), bounceType: 'hard' });
		expect(await replay(t, failureId)).toBe('replayed');
		expect((await sendOf(t, sendId))?.status).toBe('bounced');
	});

	it('keeps an SMTP relay DSN that our own bounce server reports', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		const failureId = await failCompletion(t, sendId, 'smtp-verp', 'smtp');

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionMtaByProviderMessageId,
			{
				providerMessageId: 'smtp-verp',
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);
		expect(outcome).toMatchObject({ ok: false, reason: 'illegal_edge' });
		expect((await failureRows(t))[0]?.pendingFeedback).toHaveLength(1);

		expect(await replay(t, failureId)).toBe('replayed');
		expect((await sendOf(t, sendId))?.status).toBe('bounced');
	});

	it('never drops a hard bounce behind a run of soft bounces', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		const failureId = await failCompletion(t, sendId, 'full');
		const at = Date.now();

		for (let i = 0; i < 25; i++) {
			await webhook(t, 'full', { to: 'bounced', at: at + i, bounceType: 'soft' });
		}
		await webhook(t, 'full', { to: 'bounced', at: at + 30, bounceType: 'hard' });
		const parked = (await failureRows(t))[0]?.pendingFeedback ?? [];
		expect(parked.map((event) => event.transition)).toEqual([
			{ to: 'bounced', at: at + 24, bounceType: 'soft' },
			{ to: 'bounced', at: at + 30, bounceType: 'hard' },
		]);

		expect(await replay(t, failureId)).toBe('replayed');
		expect(await sendOf(t, sendId)).toMatchObject({ status: 'bounced', bounceType: 'hard' });
	});

	it('replays parked events in provider-time order and records what the lifecycle refuses', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await setupQueuedSend(t);
		const failureId = await failCompletion(t, sendId, 'chrono');
		const at = Date.now();

		// The complaint arrives first but happened last; the hard bounce stamped
		// after it can no longer apply.
		await webhook(t, 'chrono', { to: 'complained', at: at + 2000 });
		await webhook(t, 'chrono', { to: 'bounced', at: at + 1000, bounceType: 'soft' });
		await webhook(t, 'chrono', { to: 'bounced', at: at + 3000, bounceType: 'hard' });

		expect(await replay(t, failureId)).toBe('replayed');
		expect(await sendOf(t, sendId)).toMatchObject({ status: 'complained', bouncedAt: at + 1000 });
		const [resolved] = await failureRows(t);
		expect(resolved?.pendingFeedback).toBeUndefined();
		expect(resolved?.feedbackRefusals).toEqual([
			{ to: 'bounced', at: at + 3000, reason: expect.any(String) },
		]);
	});
});
