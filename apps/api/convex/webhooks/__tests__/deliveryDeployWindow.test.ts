/**
 * Outbound webhooks across the deploy that introduced the attempt model.
 *
 * - Scheduling: an event is handed to the scheduler as the enqueue MUTATION, so
 *   no at-most-once action sits between the event and its delivery rows.
 * - Rows the previous release left open carry no `recoverAfter`; the
 *   reconciler gives them one and recovers them like any other lost attempt,
 *   unless they have waited past the abandon cutoff, in which case they are
 *   failed without being sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import type * as SsrfGuard from '../../lib/ssrfGuard';
import { MAX_WEBHOOK_ATTEMPTS } from '../../lib/constants';
import { WEBHOOK_ATTEMPT_LEASE_MS } from '../deliveryAttempts';
import {
	LEGACY_DELIVERY_ABANDON_AFTER_MS,
	LEGACY_DELIVERY_ABANDONED_ERROR,
} from '../deliveryReconciler';
import { scheduleDeliver, scheduleFanout } from '../scheduleFanout';
import {
	currentAttempt,
	fetchMock,
	invoke,
	job,
	PAYLOAD,
	reconcile,
	row,
	setup,
	type LogId,
	type T,
} from './deliveryHarness';

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

const scheduledJobs = (t: T) =>
	t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

/** Run the jobs due now, and nothing they schedule in turn. */
async function runDueJobs(t: T): Promise<void> {
	vi.runOnlyPendingTimers();
	await t.finishInProgressScheduledFunctions();
}

const logsOf = (t: T) => t.run((ctx) => ctx.db.query('webhookDeliveryLogs').collect());

/** A row as the previous release wrote it: no sequence, job id or deadline. */
function insertLegacyRow(t: T, webhookId: Id<'webhooks'>, fields: Record<string, unknown> = {}) {
	return t.run((ctx) =>
		ctx.db.insert('webhookDeliveryLogs', {
			webhookId,
			event: 'contact.created',
			payload: PAYLOAD,
			payloadVersion: 1,
			attemptNumber: 1,
			maxAttempts: MAX_WEBHOOK_ATTEMPTS,
			status: 'pending',
			scheduledAt: Date.now(),
			...fields,
		})
	);
}

/** An unsequenced invocation, as the previous release scheduled it. */
const legacyInvocation = (webhookId: Id<'webhooks'>, logId: LogId, attemptNumber: number) => ({
	webhookId,
	logId,
	attemptNumber,
	payload: JSON.stringify(PAYLOAD),
});

describe('scheduling an event', () => {
	it('scheduleFanout schedules the fanout mutation, which writes the rows', async () => {
		const { t, webhookId } = await setup();

		await t.run((ctx) =>
			scheduleFanout(ctx, {
				literal: 'contact.created',
				input: {
					contactId: 'contact-1' as Id<'contacts'>,
					email: 'someone@example.com',
					source: 'api',
					at: Date.now(),
				},
			})
		);

		const [queued] = await scheduledJobs(t);
		expect(queued?.name).toBe('webhooks/deliveryQueries:enqueueFanoutDeliveries');
		expect(queued?.args[0]).toMatchObject({
			event: 'contact.created',
			payload: {
				event: 'contact.created',
				timestamp: new Date().toISOString(),
				data: { email: 'someone@example.com', source: 'api' },
			},
		});

		await runDueJobs(t);
		const [log] = await logsOf(t);
		expect(log).toMatchObject({ webhookId, status: 'pending', attemptSeq: 1 });
		expect((await job(t, log?.scheduledFunctionId))?.state.kind).toBe('pending');
	});

	it('scheduleDeliver schedules the single-target mutation', async () => {
		const { t, webhookId } = await setup();

		await t.run((ctx) =>
			scheduleDeliver(ctx, webhookId, {
				literal: 'test',
				input: { webhookId, webhookName: 'Receiver' },
			})
		);

		const [queued] = await scheduledJobs(t);
		expect(queued?.name).toBe('webhooks/deliveryQueries:enqueueDelivery');
		await runDueJobs(t);
		expect(await logsOf(t)).toMatchObject([{ webhookId, event: 'test', attemptSeq: 1 }]);
	});
});

describe('rows the previous release left open', () => {
	it('a stuck pending row is recovered under sequence 1, and its old job is a no-op', async () => {
		const { t, webhookId } = await setup();
		const logId = await insertLegacyRow(t, webhookId, { scheduledAt: Date.now() - 60 * 60_000 });

		// Adoption gives the row a lease from now, not from when it fell due:
		// its old attempt may still be queued or running, and the row carries no
		// job id to check, so the same pass must not re-issue it.
		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 0 });
		const adopted = await row(t, logId);
		expect(adopted.recoverAfter).toBe(Date.now() + WEBHOOK_ATTEMPT_LEASE_MS);
		expect(adopted.attemptSeq).toBeUndefined();
		expect(await scheduledJobs(t)).toHaveLength(0);

		vi.setSystemTime(Date.now() + WEBHOOK_ATTEMPT_LEASE_MS + 1);
		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 1, failed: 0 });

		const log = await row(t, logId);
		expect(log).toMatchObject({ status: 'pending', attemptNumber: 1, attemptSeq: 1 });
		expect((await job(t, log.scheduledFunctionId))?.state.kind).toBe('pending');
		expect((await invoke(t, legacyInvocation(webhookId, logId, 1))).skipped).toBe(true);
		expect((await invoke(t, await currentAttempt(t, logId))).success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('a stuck retrying row is recovered once its retry time plus a lease has passed', async () => {
		const { t, webhookId } = await setup();
		const nextRetryAt = Date.now() + 10 * 60_000;
		const logId = await insertLegacyRow(t, webhookId, {
			status: 'retrying',
			attemptNumber: 2,
			nextRetryAt,
		});

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 0 });
		const adopted = await row(t, logId);
		expect(adopted.attemptSeq).toBeUndefined();
		expect(adopted.recoverAfter).toBe(nextRetryAt + WEBHOOK_ATTEMPT_LEASE_MS);

		vi.setSystemTime(nextRetryAt + WEBHOOK_ATTEMPT_LEASE_MS + 1);
		expect(await reconcile(t)).toMatchObject({ rescheduled: 1 });
		expect(await row(t, logId)).toMatchObject({
			status: 'retrying',
			attemptNumber: 2,
			attemptSeq: 1,
		});
	});

	it('an old retry job that runs on time still delivers the adopted row', async () => {
		const { t, webhookId } = await setup();
		const nextRetryAt = Date.now() + 60_000;
		const logId = await insertLegacyRow(t, webhookId, {
			status: 'retrying',
			attemptNumber: 2,
			nextRetryAt,
		});
		await reconcile(t);

		vi.setSystemTime(nextRetryAt);
		expect((await invoke(t, legacyInvocation(webhookId, logId, 2))).success).toBe(true);
		expect((await row(t, logId)).status).toBe('success');
	});

	it('fails a row stuck past the cutoff instead of sending it', async () => {
		const { t, webhookId } = await setup();
		const logId = await insertLegacyRow(t, webhookId, {
			scheduledAt: Date.now() - LEGACY_DELIVERY_ABANDON_AFTER_MS - 60_000,
		});

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 1 });

		const log = await row(t, logId);
		expect(log).toMatchObject({
			status: 'failed',
			errorMessage: LEGACY_DELIVERY_ABANDONED_ERROR,
			completedAt: Date.now(),
		});
		expect(log.attemptedAt).toBeUndefined();
		expect(log.recoverAfter).toBeUndefined();
		expect(log.attemptSeq).toBeUndefined();
		expect(await scheduledJobs(t)).toHaveLength(0);
		expect((await invoke(t, legacyInvocation(webhookId, logId, 1))).skipped).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("measures a retrying row's wait from its retry time and keeps its last attempt", async () => {
		const { t, webhookId } = await setup();
		const attemptedAt = Date.now() - 3 * LEGACY_DELIVERY_ABANDON_AFTER_MS;
		const stale = await insertLegacyRow(t, webhookId, {
			status: 'retrying',
			attemptNumber: 2,
			scheduledAt: attemptedAt,
			attemptedAt,
			nextRetryAt: Date.now() - LEGACY_DELIVERY_ABANDON_AFTER_MS - 1,
			errorMessage: 'HTTP 503',
		});
		// Opened long ago, but its retry fell due within the cutoff.
		const recent = await insertLegacyRow(t, webhookId, {
			status: 'retrying',
			attemptNumber: 2,
			scheduledAt: attemptedAt,
			attemptedAt,
			nextRetryAt: Date.now() - LEGACY_DELIVERY_ABANDON_AFTER_MS + 60 * 60_000,
		});

		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 0, failed: 1 });
		expect(await row(t, stale)).toMatchObject({
			status: 'failed',
			errorMessage: LEGACY_DELIVERY_ABANDONED_ERROR,
			attemptedAt,
		});
		vi.setSystemTime(Date.now() + WEBHOOK_ATTEMPT_LEASE_MS + 1);
		expect(await reconcile(t)).toEqual({ waiting: 0, rescheduled: 1, failed: 0 });
		expect(await row(t, recent)).toMatchObject({
			status: 'retrying',
			attemptNumber: 2,
			attemptSeq: 1,
		});
	});

	it('gives untracked rows their deadline in bounded batches', async () => {
		const { t, webhookId } = await setup();
		for (let i = 0; i < 51; i++) {
			await insertLegacyRow(t, webhookId, { nextRetryAt: Date.now() + 60 * 60_000 });
		}

		await reconcile(t);
		const untracked = (await logsOf(t)).filter((log) => log.recoverAfter === undefined);
		expect(untracked).toHaveLength(1);
		const continuations = (await scheduledJobs(t)).filter(
			(j) => j.name === 'webhooks/deliveryReconciler:reconcileOverdueDeliveries'
		);
		expect(continuations).toHaveLength(1);

		await reconcile(t);
		expect((await logsOf(t)).every((log) => log.recoverAfter !== undefined)).toBe(true);
	});
});
