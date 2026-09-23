/**
 * Outbound webhook delivery against a real database: the attempt lifecycle
 * (issue #809 finding 7) and the bounded response preview (finding 8).
 *
 * The delivery action runs by calling its handler directly (see
 * `deliveryHarness.ts`). Timers are faked so nothing the mutations schedule runs on its own:
 * each test decides which invocation happens, which is what makes duplicate
 * and stale invocations reproducible. Only the network edge is replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meteredStream } from '../../lib/__tests__/meteredStream';
import type * as SsrfGuard from '../../lib/ssrfGuard';
import { WEBHOOK_ATTEMPT_LEASE_MS } from '../deliveryAttempts';
import {
	currentAttempt,
	deferredResponse,
	enqueue,
	fetchMock,
	invoke,
	job,
	PAYLOAD,
	reconcile,
	row,
	sentHeaders,
	setup,
	type T,
} from './deliveryHarness';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestWebhook } from '../../__tests__/factories';

vi.mock('../../lib/ssrfGuard', async (importOriginal) => ({
	...(await importOriginal<typeof SsrfGuard>()),
	validatePublicUrl: vi.fn(async (url: string) => ({ ok: true, url: new URL(url) })),
	fetchWithGuardedDispatcher: vi.fn(),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => new Response('ok', { status: 200 }));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('webhook delivery persistence and scheduling', () => {
	it('fanout writes each delivery with its first attempt scheduled in the same mutation', async () => {
		const { t, webhookId } = await setup();
		const otherId = await t.run((ctx) =>
			ctx.db.insert('webhooks', createTestWebhook({ isActive: true, events: ['contact.created'] }))
		);
		await t.run((ctx) =>
			ctx.db.insert('webhooks', createTestWebhook({ isActive: true, events: ['email.sent'] }))
		);

		const deliveries = await t.mutation(internal.webhooks.deliveryQueries.enqueueFanoutDeliveries, {
			event: 'contact.created',
			payload: PAYLOAD,
		});

		expect(deliveries.map((d) => d.webhookId).sort()).toEqual([webhookId, otherId].sort());
		for (const { logId, webhookId: target } of deliveries) {
			const log = await row(t, logId);
			expect(log).toMatchObject({ status: 'pending', attemptNumber: 1, attemptSeq: 1 });
			expect(log.recoverAfter).toBeGreaterThan(Date.now());
			const scheduled = await job(t, log.scheduledFunctionId);
			expect(scheduled?.name).toBe('webhooks/delivery:deliverWebhookInternal');
			expect(scheduled?.state.kind).toBe('pending');
			expect(scheduled?.args[0]).toEqual({
				webhookId: target,
				logId,
				attemptNumber: 1,
				attemptSeq: 1,
			});
		}
	});

	it('a failed attempt records retrying and schedules the retry together', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }));

		const result = await invoke(t, await currentAttempt(t, logId));

		expect(result).toMatchObject({ success: false, retrying: true });
		const log = await row(t, logId);
		expect(log).toMatchObject({
			status: 'retrying',
			attemptNumber: 2,
			attemptSeq: 2,
			httpStatusCode: 503,
			errorMessage: 'HTTP 503: nope',
			nextRetryAt: Date.now() + 60_000,
		});
		const retry = await job(t, log.scheduledFunctionId);
		expect(retry?.state.kind).toBe('pending');
		expect(retry?.scheduledTime).toBe(Date.now() + 60_000);
		expect(retry?.args[0]).toMatchObject({ logId, attemptNumber: 2, attemptSeq: 2 });
	});

	it('sends a delivery id that stays the same across retries', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));

		await invoke(t, await currentAttempt(t, logId));
		const retried = await invoke(t, await currentAttempt(t, logId));

		expect(retried.success).toBe(true);
		const [first, second] = sentHeaders();
		expect(first?.['X-Webhook-Delivery-Id']).toBe(logId);
		expect(second?.['X-Webhook-Delivery-Id']).toBe(logId);
		expect([first?.['X-Webhook-Attempt'], second?.['X-Webhook-Attempt']]).toEqual(['1', '2']);
		expect((await row(t, logId)).status).toBe('success');
	});

	it('still delivers an invocation scheduled before attempts carried a sequence', async () => {
		const { t, webhookId } = await setup();
		const logId = await t.run((ctx) =>
			ctx.db.insert('webhookDeliveryLogs', {
				webhookId,
				event: 'contact.created',
				payload: PAYLOAD,
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'pending',
				scheduledAt: Date.now(),
			})
		);

		const result = await invoke(t, {
			webhookId,
			logId,
			attemptNumber: 1,
			payload: JSON.stringify(PAYLOAD),
		});

		expect(result.success).toBe(true);
		expect((await row(t, logId)).status).toBe('success');
	});
});

describe('duplicate and stale invocations', () => {
	it('a second invocation of an attempt already in flight sends nothing', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const attempt = await currentAttempt(t, logId);
		const pending = deferredResponse();
		fetchMock.mockImplementationOnce(() => pending.promise);

		const first = invoke(t, attempt);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const duplicate = await invoke(t, attempt);
		pending.resolve(new Response('ok', { status: 200 }));

		expect(duplicate).toMatchObject({ skipped: true, error: 'Attempt already claimed' });
		expect((await first).success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((await row(t, logId)).status).toBe('success');
	});

	it('an invocation arriving after the delivery finished is a no-op', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const attempt = await currentAttempt(t, logId);
		await invoke(t, attempt);
		const finished = await row(t, logId);

		const late = await invoke(t, attempt);

		expect(late).toMatchObject({ skipped: true, error: 'Stale attempt' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await row(t, logId)).toEqual(finished);
	});

	it('a superseded attempt cannot record its outcome over the re-issued one', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const stale = await currentAttempt(t, logId);
		const pending = deferredResponse();
		fetchMock.mockImplementationOnce(() => pending.promise);

		const inFlight = invoke(t, stale);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		// The attempt's job is lost (cancelled here) and its lease runs out, so
		// the reconciler re-issues the attempt under a new sequence.
		await t.run(async (ctx) => {
			const log = (await ctx.db.get(logId))!;
			await ctx.scheduler.cancel(log.scheduledFunctionId!);
		});
		vi.setSystemTime(Date.now() + WEBHOOK_ATTEMPT_LEASE_MS + 1);
		expect(await reconcile(t)).toMatchObject({ rescheduled: 1 });

		// The old invocation now comes back with a failure: it must not move the
		// row to retrying or schedule a retry of its own.
		pending.resolve(new Response('late failure', { status: 500 }));
		expect((await inFlight).retrying).toBe(false);
		const log = await row(t, logId);
		expect(log).toMatchObject({ status: 'pending', attemptNumber: 1, attemptSeq: 2 });
		expect(log.httpStatusCode).toBeUndefined();

		expect((await invoke(t, stale)).skipped).toBe(true);
		expect((await invoke(t, await currentAttempt(t, logId))).success).toBe(true);
		expect((await row(t, logId)).status).toBe('success');
	});
});

describe('reconcileOverdueDeliveries', () => {
	async function insertOverdue(
		t: T,
		webhookId: Id<'webhooks'>,
		fields: Record<string, unknown> = {}
	) {
		return await t.run((ctx) =>
			ctx.db.insert('webhookDeliveryLogs', {
				webhookId,
				event: 'contact.created',
				payload: PAYLOAD,
				attemptNumber: 1,
				maxAttempts: 3,
				status: 'pending',
				scheduledAt: Date.now() - 60 * 60_000,
				attemptSeq: 1,
				recoverAfter: Date.now() - 1,
				...fields,
			})
		);
	}

	it('recovers a row persisted without its attempt ever being scheduled', async () => {
		const { t, webhookId } = await setup();
		// The state an interruption between persistence and scheduling leaves:
		// a pending row and no scheduler job behind it.
		const logId = await insertOverdue(t, webhookId);

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 1, failed: 0 });

		const log = await row(t, logId);
		expect(log).toMatchObject({
			status: 'pending',
			attemptNumber: 1,
			attemptSeq: 2,
			recoveryCount: 1,
		});
		const scheduled = await job(t, log.scheduledFunctionId);
		expect(scheduled?.state.kind).toBe('pending');
		expect(scheduled?.args[0]).toMatchObject({ logId, attemptNumber: 1, attemptSeq: 2 });

		expect((await invoke(t, await currentAttempt(t, logId))).success).toBe(true);
		expect((await row(t, logId)).status).toBe('success');
	});

	it('recovers a retrying row whose retry job was cancelled', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
		await invoke(t, await currentAttempt(t, logId));
		const retrying = await row(t, logId);
		await t.run((ctx) => ctx.scheduler.cancel(retrying.scheduledFunctionId!));

		vi.setSystemTime(retrying.recoverAfter! + 1);
		expect(await reconcile(t)).toMatchObject({ rescheduled: 1 });
		expect(await row(t, logId)).toMatchObject({
			status: 'retrying',
			attemptNumber: 2,
			attemptSeq: 3,
		});
	});

	it('leaves an overdue attempt alone while its job is still queued', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const before = await row(t, logId);

		vi.setSystemTime(before.recoverAfter! + 1);
		expect(await reconcile(t)).toEqual({ waiting: 1, rescheduled: 0, failed: 0 });

		const after = await row(t, logId);
		expect(after.attemptSeq).toBe(before.attemptSeq);
		expect(after.scheduledFunctionId).toBe(before.scheduledFunctionId);
		expect(after.recoverAfter).toBe(Date.now() + WEBHOOK_ATTEMPT_LEASE_MS);
	});

	it('fails a delivery whose attempt keeps getting lost instead of looping', async () => {
		const { t, webhookId } = await setup();
		const logId = await insertOverdue(t, webhookId, { recoveryCount: 3 });

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 1 });
		const log = await row(t, logId);
		expect(log).toMatchObject({
			status: 'failed',
			errorMessage: 'Delivery attempt never completed',
		});
		expect(log.recoverAfter).toBeUndefined();
	});

	it('ignores rows that are not yet overdue, finished, or predate attempt tracking', async () => {
		const { t, webhookId } = await setup();
		await insertOverdue(t, webhookId, { recoverAfter: Date.now() + 60_000 });
		await insertOverdue(t, webhookId, { status: 'success', completedAt: Date.now() });
		await insertOverdue(t, webhookId, { attemptSeq: undefined, recoverAfter: undefined });

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 0 });
	});

	it('works in bounded batches and continues itself when a batch is full', async () => {
		const { t, webhookId } = await setup();
		for (let i = 0; i < 51; i++) await insertOverdue(t, webhookId);

		expect(await reconcile(t)).toMatchObject({ rescheduled: 50 });
		const continuations = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(j) => j.name === 'webhooks/deliveryReconciler:reconcileOverdueDeliveries'
			)
		);
		expect(continuations).toHaveLength(1);

		expect(await reconcile(t)).toMatchObject({ rescheduled: 1 });
	});
});

describe('response preview', () => {
	const endless = () => meteredStream(() => new Uint8Array(1024).fill(0x61));

	it('delivers a 2xx with a never-ending body once, reading only a bounded preview', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const { stream, meter } = endless();
		fetchMock.mockImplementationOnce(async () => new Response(stream, { status: 200 }));

		const result = await invoke(t, await currentAttempt(t, logId));

		expect(result.success).toBe(true);
		expect(meter.pulledBytes).toBeLessThanOrEqual(4000 + 1024);
		expect(meter.cancelled).toBe(true);
		const log = await row(t, logId);
		expect(log.status).toBe('success');
		expect(log.responseBody).toBe(`${'a'.repeat(1000)}...`);
		expect(
			await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
		).toHaveLength(1);
	});

	it('delivers a 2xx whose body fails mid-read', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const { stream } = meteredStream((i) =>
			i === 0 ? new TextEncoder().encode('partial') : new Error('socket hang up')
		);
		fetchMock.mockImplementationOnce(async () => new Response(stream, { status: 202 }));

		expect((await invoke(t, await currentAttempt(t, logId))).success).toBe(true);
		expect(await row(t, logId)).toMatchObject({ status: 'success', httpStatusCode: 202 });
	});

	it('keeps a multibyte error body intact at the preview cut', async () => {
		const { t, webhookId } = await setup();
		const logId = await enqueue(t, webhookId);
		const body = new TextEncoder().encode('€'.repeat(5000));
		// Chunk boundaries that fall inside the 3-byte euro sign.
		const chunks = [body.subarray(0, 1001), body.subarray(1001, 2002), body.subarray(2002)];
		const { stream, meter } = meteredStream((i) => chunks[i]);
		fetchMock.mockImplementationOnce(async () => new Response(stream, { status: 500 }));

		await invoke(t, await currentAttempt(t, logId));

		const log = await row(t, logId);
		expect(log.responseBody).toBe(`${'€'.repeat(1000)}...`);
		expect(log.errorMessage).toBe(`HTTP 500: ${'€'.repeat(1000)}...`);
		expect(meter.cancelled).toBe(true);
	});
});
