/**
 * WHAT THE RAMP CRON WRITES, end to end — the shell's own contract.
 *
 * The per-rule suites (`mixDecisions`, `killSwitch`, `rampPaceActuation`, ...)
 * pin one rule each. This one pins the shape of a tick: which slice it takes for
 * a given cursor, what it answers, the continuation it schedules, and the exact
 * `auditLogs` row an automatic change leaves behind. It holds the cron to the
 * same writes however its deciding is arranged.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { PACE_AIMD } from '../ramp/paceConfig';
import { DAY_MS } from '../../lib/constants';
import { readManagedCell, seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_shell';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_shell'),
	};
});

const START = Date.UTC(2026, 6, 1, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
});

async function scheduledContinuations(t: Harness) {
	const jobs = await t.run(
		async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
	);
	return jobs.map((job) => ({ name: job.name, args: job.args }));
}

async function tick(t: Harness, args: { cursor?: number }) {
	return await t.mutation(internal.delivery.rampControllerCron.runRampController, args);
}

describe('the slice a cursor selects', () => {
	// The managed cell (campaign x gmail) is the first cell of the 15-cell grid.
	it.each([
		{ cursor: undefined, evaluated: 1, next: 5 },
		{ cursor: 0, evaluated: 1, next: 5 },
		{ cursor: -4, evaluated: 1, next: 5 },
		{ cursor: Number.POSITIVE_INFINITY, evaluated: 1, next: 5 },
		{ cursor: 0.9, evaluated: 1, next: 5 },
		{ cursor: 2.9, evaluated: 0, next: 7 },
		{ cursor: 5, evaluated: 0, next: 10 },
	])('cursor $cursor evaluates $evaluated and continues at $next', async (row) => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });

		const result = await tick(t, row.cursor === undefined ? {} : { cursor: row.cursor });

		expect(result).toEqual({ evaluated: row.evaluated, done: false });
		expect(await scheduledContinuations(t)).toEqual([
			{
				name: 'delivery/rampControllerCron:runRampController',
				args: [{ cursor: row.next }],
			},
		]);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(row.evaluated);
	});

	it.each([10, 12])('the last slice (cursor %s) schedules nothing', async (cursor) => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });

		expect(await tick(t, { cursor })).toEqual({ evaluated: 0, done: true });
		expect(await scheduledContinuations(t)).toEqual([]);
	});

	it.each([15, 99])('a cursor past the grid (%s) reads and writes nothing', async (cursor) => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		const before = await readManagedCell(t);

		expect(await tick(t, { cursor })).toEqual({ evaluated: 0, done: true });
		expect(await scheduledContinuations(t)).toEqual([]);
		expect(await readManagedCell(t)).toEqual(before);
		expect(await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect())).toEqual([]);
	});
});

describe('the audit row an automatic change leaves', () => {
	it('logs both dials of a hard stop, field for field', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.5,
			paceMultiplier: 1,
			warming: { dailyCap: 1_000, sentToday: 900 },
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: START }],
		});

		await tick(t, {});

		const logs = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			userId: 'system',
			organizationId: ORG,
			action: 'deliverability_ramp.decision_applied',
			resource: 'deliverability_ramp',
			resourceId: 'campaign:gmail',
		});
		expect(logs[0]?.details).toEqual({
			cell: 'campaign:gmail',
			fromShare: 0.5,
			toShare: 0,
			direction: 'decrease',
			reason: 'dnsbl',
			verdict: 'not_evaluated',
			fromPaceMultiplier: 1,
			toPaceMultiplier: PACE_AIMD.multiplierFloor,
			paceDirection: 'decrease',
			paceReason: 'dnsbl',
		});

		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			fromShare: 0.5,
			toShare: 0,
			reason: 'dnsbl',
			fromPaceMultiplier: 1,
			toPaceMultiplier: PACE_AIMD.multiplierFloor,
			paceDirection: 'decrease',
			isPaceDeferred: false,
		});
		const managed = await readManagedCell(t);
		expect(managed?.ownShare).toBe(0);
		expect(managed?.paceMultiplier).toBe(PACE_AIMD.multiplierFloor);
	});

	it('names the failed gate of a breach, and only then', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.5 });
		await t.run(async (ctx) => {
			await ctx.db.insert('transportOutcomes', {
				organizationId: ORG,
				cell: 'campaign:gmail',
				arm: 'own' as const,
				periodStart: Math.floor(START / DAY_MS) * DAY_MS,
				shardKey: 0,
				sent: 1_000,
				delivered: 800,
				deferred: 0,
				softBounced: 0,
				hardBounced: 200,
				complained: 0,
				opened: 0,
				clicked: 0,
				unsubscribed: 0,
				calibrationSent: 0,
				calibrationOpened: 0,
				calibrationClicked: 0,
				lastRecordedAt: START,
			});
		});

		await tick(t, {});

		const logs = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(logs.map((row) => row.details)).toEqual([
			{
				cell: 'campaign:gmail',
				fromShare: 0.5,
				toShare: 0.25,
				direction: 'decrease',
				reason: 'hard_bounce',
				verdict: 'fail',
				failedGate: 'hard_bounce',
				fromPaceMultiplier: 1,
				toPaceMultiplier: 0.5,
				paceDirection: 'decrease',
				paceReason: 'hard_bounce',
			},
		]);
	});

	it('a paused controller audits the evaluation, writes only the lease and logs nothing', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, {
			organizationId: ORG,
			isPaused: true,
			ownShare: 0.5,
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: START }],
		});
		const before = await readManagedCell(t);
		vi.setSystemTime(START + 60 * 60 * 1000);

		expect(await tick(t, {})).toEqual({ evaluated: 1, done: false });

		const after = await readManagedCell(t);
		expect({ ...after, expiresAt: before?.expiresAt }).toEqual(before);
		expect(after?.expiresAt ?? 0).toBeGreaterThan(before?.expiresAt ?? 0);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions.map((row) => row.reason)).toEqual(['kill_switch']);
		expect(await t.run(async (ctx) => await ctx.db.query('auditLogs').collect())).toEqual([]);
	});
});
