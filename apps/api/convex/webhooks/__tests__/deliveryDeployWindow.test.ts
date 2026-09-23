/**
 * Outbound webhooks across the deploy that introduced the attempt model
 * (issue #809 finding 7, review follow-up).
 *
 * - Scheduling: an event is handed to the scheduler as the enqueue MUTATION, so
 *   no at-most-once action sits between the event and its delivery rows.
 * - Jobs the previous release queued under the old action paths still write
 *   their rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import type * as SsrfGuard from '../../lib/ssrfGuard';
import { deliverEvent, fanoutEvent } from '../fanout';
import { scheduleDeliver, scheduleFanout } from '../scheduleFanout';
import { fetchMock, job, PAYLOAD, row, setup, type LogId, type T } from './deliveryHarness';

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

type Handler<A, R> = (ctx: unknown, args: A) => Promise<R>;
const handlerOf = <A, R>(fn: unknown) => (fn as { _handler: Handler<A, R> })._handler;

/** An action context whose `runMutation` reaches convex-test, like `invoke`. */
const actionCtx = (t: T) => ({
	runMutation: t.mutation as (ref: unknown, args: unknown) => Promise<unknown>,
});

const scheduledJobs = (t: T) =>
	t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

/** Run the jobs due now, and nothing they schedule in turn. */
async function runDueJobs(t: T): Promise<void> {
	vi.runOnlyPendingTimers();
	await t.finishInProgressScheduledFunctions();
}

const logsOf = (t: T) => t.run((ctx) => ctx.db.query('webhookDeliveryLogs').collect());

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

describe('jobs the previous release queued under the old action paths', () => {
	it('fanoutEvent still writes one row per subscribed webhook', async () => {
		const { t, webhookId } = await setup();

		const result = await handlerOf<object, { webhooksTriggered: number }>(fanoutEvent)(
			actionCtx(t),
			{ event: 'contact.created', data: PAYLOAD.data }
		);

		expect(result.webhooksTriggered).toBe(1);
		expect(await logsOf(t)).toMatchObject([{ webhookId, status: 'pending', attemptSeq: 1 }]);
	});

	it('deliverEvent still writes the row for its target', async () => {
		const { t, webhookId } = await setup();

		const result = await handlerOf<object, { success: boolean; logId?: LogId }>(deliverEvent)(
			actionCtx(t),
			{ webhookId, event: 'contact.created', data: PAYLOAD.data }
		);

		expect(result.success).toBe(true);
		expect(await row(t, result.logId!)).toMatchObject({ webhookId, attemptSeq: 1 });
	});
});
