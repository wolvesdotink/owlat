/**
 * The lost-send sweep runs one pass per table and mode at a time (#1208).
 *
 * A pass holds a lease row while its page chain runs. The hourly cron must not
 * start a second pass over a range the first is still scheduling, a pass whose
 * chain died is taken over, a superseded chain stops at its next page, and the
 * operator's pass always takes over.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { DAY } from './helpers/sendCompletionFailures';
import {
	at,
	drainSweep,
	getSend,
	holdLease,
	HOUR,
	pendingPages,
	queuedCampaignSend,
	runCron,
	T0,
} from './helpers/stuckSendSweep';
import { UNANCHORED_MIN_AGE_MS } from '../delivery/stuckSendSweep';

vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction: vi.fn() },
	transactionalEmailPool: { enqueueAction: vi.fn() },
}));

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	vi.useRealTimers();
});

describe('one pass at a time', () => {
	it('does not start a pass over a table whose previous pass is still running', async () => {
		const t = convexTest(schema, modules);
		await holdLease(t, 'emailSends:deadline', 4, T0);
		at(T0 + HOUR);
		const result = await t.mutation(internal.delivery.stuckSendSweep.sweepLostSends, {});
		expect(result).toMatchObject({ started: ['transactionalSends'], busy: ['emailSends'] });
		const pages = await pendingPages(t);
		expect(pages.map((job) => (job.args[0] as { table: string }).table)).toEqual([
			'transactionalSends',
		]);
	});

	it('takes over a pass whose chain went quiet, and the old chain stops', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await queuedCampaignSend(t, { firstAttemptAt: T0 });
		await holdLease(t, 'emailSends:deadline', 4, T0);
		at(T0 + 6 * DAY);
		const result = await t.mutation(internal.delivery.stuckSendSweep.sweepLostSends, {});
		expect(result.started).toEqual(['emailSends', 'transactionalSends']);

		// A page of the dead generation finds the lease moved on and does nothing.
		const stale = await t.mutation(internal.delivery.stuckSendSweep.sweepLostSendPage, {
			table: 'emailSends',
			mode: 'deadline',
			cutoff: T0 + DAY,
			cursor: null,
			generation: 4,
		});
		expect(stale).toMatchObject({ isSuperseded: true, scheduled: 0 });

		await drainSweep(t);
		expect((await getSend(t, sendId))?.status).toBe('failed');
		const leases = await t.run(async (ctx) => await ctx.db.query('lostSendSweepLeases').collect());
		expect(leases.map((lease) => [lease.pass, lease.generation, lease.isActive]).sort()).toEqual([
			['emailSends:deadline', 5, false],
			['transactionalSends:deadline', 1, false],
		]);
	});

	it('starts the next pass once the previous one has finished', async () => {
		const t = convexTest(schema, modules);
		at(T0);
		await runCron(t);
		at(T0 + HOUR);
		const result = await t.mutation(internal.delivery.stuckSendSweep.sweepLostSends, {});
		expect(result.busy).toEqual([]);
	});

	it('lets the operator pass take over a running unanchored pass', async () => {
		const t = convexTest(schema, modules);
		await holdLease(t, 'emailSends:unanchored', 2, T0 + 30 * DAY);
		at(T0 + 30 * DAY);
		await t.mutation(internal.delivery.stuckSendSweepAdmin.failUnanchoredLostSends, {
			createdBefore: T0 + 30 * DAY - UNANCHORED_MIN_AGE_MS,
		});
		const pages = await pendingPages(t);
		expect(
			pages.map((job) => {
				const args = job.args[0] as { table: string; generation: number };
				return [args.table, args.generation];
			})
		).toEqual([
			['emailSends', 3],
			['transactionalSends', 1],
		]);
	});
});
