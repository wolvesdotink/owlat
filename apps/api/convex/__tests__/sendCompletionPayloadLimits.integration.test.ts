/**
 * Recorded send completions stay small, so every path stays inside Convex's
 * transaction read limit (#1195).
 *
 * A deferral's worker outcome carries the rendered message, up to the 1 MiB
 * document limit. The record keeps a compact form instead: the envelope is
 * emptied, the rest is capped at 32 KiB at write, and a deferral that would
 * still be re-entered is re-entered at once rather than stored. These tests
 * run with convex-test's real transaction limits and feed the completion shell
 * outcomes near the document limit, then drive every listing and deletion path
 * to completion.
 */

import { convexTest } from 'convex-test';
import { getConvexSize, type Value } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
import { beginWorkspaceDeletion, readDeletionProgress } from '../workspaces/deletion/job';
import { PAYLOAD_MAX_BYTES } from '../delivery/sendCompletionPayload';
import {
	acceptedCompletion,
	DAY,
	expiredDeferral,
	failureRows,
	insertResolvedRecords,
	payloadRows,
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
const LARGE_HTML = 'x'.repeat(700 * 1024);

/**
 * A body that makes the worker result, stored whole as it was before it was
 * compacted, a document one byte under the 1 MiB limit. The id lengths are
 * convex-test's (a 22-digit counter and the table name).
 */
function nearMaxHtml(result: {
	returnValue: { envelopeInput: { template: { htmlContent: string } } };
}): string {
	result.returnValue.envelopeInput.template.htmlContent = '';
	const base = getConvexSize({
		_id: 'i'.repeat(22 + 'sendCompletionFailurePayloads'.length),
		_creationTime: 0,
		failureId: 'i'.repeat(22 + 'sendCompletionFailures'.length),
		result: result as unknown as Value,
	});
	return 'x'.repeat(1024 * 1024 - 1 - base);
}

beforeEach(() => {
	fault.isArmed = false;
});

function harness(): T {
	return convexTest({ schema, modules, transactionLimits: true }) as T;
}

/** `count` throwing completions of expired deferrals with an `html` body each. */
async function recordHeavyFailures(
	t: T,
	count: number,
	html: string
): Promise<{ sendId: Id<'emailSends'>; contactId: Id<'contacts'> }> {
	const { sendId } = await setupQueuedSend(t);
	const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
	fault.isArmed = true;
	for (let i = 0; i < count; i++) {
		const args = expiredDeferral(sendId, send.contactId, send.contactEmail, `heavy-${i}`);
		args.result.returnValue.envelopeInput.template.htmlContent =
			html === 'near-max' ? nearMaxHtml(args.result) : html;
		await t.mutation(internal.delivery.sendCompletion.completeSend, args);
	}
	fault.isArmed = false;
	return { sendId, contactId: send.contactId };
}

/** Age every record past the retention window as `exhausted`. */
async function exhaustAndAge(t: T): Promise<void> {
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query('sendCompletionFailures').collect()) {
			if (row.status === 'resolved') continue;
			await ctx.db.patch(row._id, {
				status: 'exhausted',
				nextReplayAt: undefined,
				lastFailedAt: Date.now() - 91 * DAY,
			});
		}
	});
}

describe('stored outcomes stay small', () => {
	it('keeps the envelope out of the payload and under the cap', async () => {
		const t = harness();
		await recordHeavyFailures(t, 1, 'near-max');
		const [payload] = await payloadRows(t);
		expect(payload?.isEnvelopeStripped).toBe(true);
		expect(JSON.stringify(payload).length).toBeLessThan(PAYLOAD_MAX_BYTES);
	});

	it('purges 192 small and 8 near-maximum records in one tick', async () => {
		const t = harness();
		const { sendId } = await recordHeavyFailures(t, 8, 'near-max');
		await insertResolvedRecords(t, sendId, 192);
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('sendCompletionFailures').collect()) {
				await ctx.db.patch(row._id, { lastFailedAt: Date.now() - 91 * DAY });
			}
		});
		await exhaustAndAge(t);

		await t.mutation(internal.delivery.sendCompletionFailureAdmin.purgeCompletionFailures, {});
		await t.finishAllScheduledFunctions(() => {});
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});

	it('lets a workspace deletion sweep 8 near-maximum records', async () => {
		const t = harness();
		await recordHeavyFailures(t, 8, 'near-max');
		const { jobId } = await t.run((ctx) =>
			beginWorkspaceDeletion(ctx, { source: 'previous_release' }, 'sendCompletionFailurePayloads')
		);
		await t.run(async (ctx) => {
			const progress = (await readDeletionProgress(ctx.db, jobId))!;
			await ctx.db.patch(progress._id, { phase: 'sweep' });
		});
		const ownSteps = new Set(['sendCompletionFailurePayloads', 'sendCompletionFailures']);
		for (let tick = 0; tick < 20; tick++) {
			const step = (await t.run((ctx) => readDeletionProgress(ctx.db, jobId)))?.step;
			if (!step || !ownSteps.has(step)) break;
			await t.mutation(internal.workspaces.deletion.walker.tick, { jobId });
		}
		expect(await payloadRows(t)).toHaveLength(0);
		expect(await failureRows(t)).toHaveLength(0);
	});

	it('parks a bounce for a Send with ten open and ten exhausted large records', async () => {
		const t = harness();
		const { sendId } = await recordHeavyFailures(t, 20, LARGE_HTML);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('sendCompletionFailures').collect();
			for (const row of rows.slice(10)) {
				await ctx.db.patch(row._id, { status: 'exhausted', nextReplayAt: undefined });
			}
		});
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'heavy-hook')
		);

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'heavy-hook',
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);
		expect(outcome).toMatchObject({ ok: false });
		const parked = (await failureRows(t)).filter((row) => row.pendingFeedback?.length);
		expect(parked).toHaveLength(1);
	});

	it('erases 25 large records inline, and more than a batch through its continuation', async () => {
		const t = harness();
		const small = await recordHeavyFailures(t, 25, LARGE_HTML);
		await t.run((ctx) =>
			permanentlyDeleteContactWithRelations(ctx, small.contactId, { decrementCount: false })
		);
		expect(await failureRows(t)).toHaveLength(0);

		const many = await recordHeavyFailures(t, 60, 'small');
		await t.run((ctx) =>
			permanentlyDeleteContactWithRelations(ctx, many.contactId, { decrementCount: false })
		);
		expect((await failureRows(t)).length).toBeGreaterThan(0);
		await t.finishAllScheduledFunctions(() => {});
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});
});

describe('outcomes the record does not replay', () => {
	it('stores an oversized outcome as PAYLOAD_TOO_LARGE for an operator to close', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			acceptedCompletion(sendId, 'oversized', { providerType: 'p'.repeat(PAYLOAD_MAX_BYTES) })
		);
		const [row] = await failureRows(t);
		expect(row).toMatchObject({ status: 'exhausted', lastError: 'PAYLOAD_TOO_LARGE' });
		expect(await payloadRows(t)).toHaveLength(0);
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.providerMessageId).toBe('oversized');

		fault.isArmed = false;
		expect(
			await t.mutation(internal.delivery.sendCompletionFailureAdmin.closeCompletionFailure, {
				failureId: row!._id,
				outcome: 'sent',
			})
		).toEqual({ closed: true, reason: null });
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('sent');
	});

	it('re-enters a deferral whose completion threw inside its retry budget, storing nothing', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
		const args = expiredDeferral(sendId, send.contactId, send.contactEmail);
		args.result.returnValue.deferralOrigin = 'governed';
		args.result.returnValue.retryState.startedAt = Date.now();
		fault.isArmed = true;
		await t.mutation(internal.delivery.sendCompletion.completeSend, args);

		expect((await failureRows(t))[0]).toMatchObject({ status: 'resolved', resolution: 'retried' });
		expect(await payloadRows(t)).toHaveLength(0);
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(jobs.filter((job) => job.name === 'delivery/sendCompletion:retrySend')).toHaveLength(1);
	});

	it('refuses to re-enter from a stripped envelope', async () => {
		const t = harness();
		const { sendId } = await setupQueuedSend(t);
		const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
		fault.isArmed = true;
		await t.mutation(
			internal.delivery.sendCompletion.completeSend,
			expiredDeferral(sendId, send.contactId, send.contactEmail, 'stripped' as WorkId)
		);
		fault.isArmed = false;
		// Make the stored deferral re-enterable again, as a clock moved back would.
		await t.run(async (ctx) => {
			const payload = (await ctx.db.query('sendCompletionFailurePayloads').first())!;
			const result = payload.result as { kind: 'success'; returnValue: Record<string, unknown> };
			const retryState = result.returnValue['retryState'] as Record<string, unknown>;
			await ctx.db.patch(payload._id, {
				result: {
					...result,
					returnValue: {
						...result.returnValue,
						retryState: { ...retryState, startedAt: Date.now() },
					},
				},
			});
		});

		const [row] = await failureRows(t);
		expect(
			await t.mutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
				failureId: row!._id,
			})
		).toBe('failed');
		expect((await failureRows(t))[0]?.lastError).toBe('ENVELOPE_NOT_STORED');
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('queued');
	});
});
