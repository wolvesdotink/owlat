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
import { DAY, statsSent, type T } from './helpers/sendCompletionFailures';
import {
	at,
	drainSweep,
	getSend,
	holdLease,
	HOUR,
	pendingPages,
	queuedCampaignSend,
	queuedTransactionalSend,
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

/** Every application table's rows, to show a call wrote nothing at all. */
async function snapshot(t: T): Promise<string> {
	return await t.run(async (ctx) => {
		const tables: Record<string, unknown[]> = {};
		for (const name of Object.keys(schema.tables).sort()) {
			tables[name] = await ctx.db.query(name as keyof typeof schema.tables).collect();
		}
		return JSON.stringify(tables);
	});
}

async function statsFailed(t: T, campaignId: string): Promise<number> {
	return await t.run(async (ctx) => {
		const shards = await ctx.db.query('campaignStatShards').collect();
		return shards
			.filter((shard) => shard.campaignId === campaignId)
			.reduce((sum, shard) => sum + (shard.statsFailed ?? 0), 0);
	});
}

describe('a Send scheduled twice (a backed-up scheduler across passes)', () => {
	// The lease ends with a pass's page chain, not with the calls it scheduled,
	// so a later pass can schedule a second call for a Send whose first has not
	// run. The second must be redundant work and nothing more.
	it('fails a campaign Send once: one status change, one failed count, one completion', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await queuedCampaignSend(t, { firstAttemptAt: T0 });
		at(T0 + 6 * DAY);
		const call = {
			sendRef: { kind: 'campaign' as const, id: sendId },
			mode: 'deadline' as const,
			cutoff: T0 + DAY,
		};
		await t.run(async (ctx) => {
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.failLostSend, call);
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.failLostSend, call);
		});
		await drainSweep(t);

		const send = await getSend(t, sendId);
		expect(send).toMatchObject({ status: 'failed', errorCode: 'SEND_COMPLETION_LOST' });
		expect(await statsFailed(t, campaignId)).toBe(1);
		expect(await statsSent(t, campaignId)).toBe(0);
		const campaign = await t.run(async (ctx) => await ctx.db.get(campaignId));
		expect(campaign?.status).toBe('sent');

		// A third call, the shape of the next pass's duplicate, writes nothing:
		// no status, counter, listing count, audit row or campaign change.
		const before = await snapshot(t);
		const again = await t.mutation(internal.delivery.stuckSendSweep.failLostSend, call);
		expect(again).toEqual({ isFailed: false, reason: 'not_queued' });
		await drainSweep(t);
		expect(await snapshot(t)).toBe(before);
	});

	it('fails a transactional Send once, and the duplicate writes nothing', async () => {
		const t = convexTest(schema, modules);
		const sendId = await queuedTransactionalSend(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(sendId, { firstAttemptAt: T0 });
		});
		at(T0 + 6 * DAY);
		const call = {
			sendRef: { kind: 'transactional' as const, id: sendId },
			mode: 'deadline' as const,
			cutoff: T0 + DAY,
		};
		await t.run(async (ctx) => {
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.failLostSend, call);
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.failLostSend, call);
		});
		await drainSweep(t);
		const failed = await getSend(t, sendId);
		expect(failed).toMatchObject({ status: 'failed', errorCode: 'SEND_COMPLETION_LOST' });

		const before = await snapshot(t);
		const again = await t.mutation(internal.delivery.stuckSendSweep.failLostSend, call);
		expect(again).toEqual({ isFailed: false, reason: 'not_queued' });
		await drainSweep(t);
		expect(await snapshot(t)).toBe(before);
	});
});
