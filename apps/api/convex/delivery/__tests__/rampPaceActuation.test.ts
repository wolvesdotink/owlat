/**
 * THE SECOND ACTUATOR, END TO END THROUGH THE CRON (plan D3, D12, D13).
 *
 * The pure suites prove the pace ladder is correct. This file proves it is
 * REACHABLE and APPLIED: that the controller loads the stored dial off the
 * route-state row, feeds it the utilisation reading the shipped `/ip-reputation`
 * sync produced, runs it through the composition interlock, and writes BOTH the
 * dial and its audit row to disk. A decision function with no caller ramps
 * nothing, and no fixture over the pure core can tell you that.
 *
 * WHAT IS DELIBERATELY NOT HERE: a pace INCREASE through the cron. The read half
 * still selects `referenceArmGateEvaluator` (see `rampControllerInputs.ts`),
 * which can only ever HOLD a deployment with no reference arm; the standalone
 * evaluator's selection is P3-8's substitution table. The increase ladder itself
 * is exhaustively fixture-pinned in `ramp/__tests__/paceActuator.test.ts`.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { PACE_AIMD } from '../ramp/paceConfig';
import { readManagedCell, seedRampCell, type SeedRampCellOptions } from './rampCronFixtures';
import { modules } from '../../__tests__/testModules';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_pace'),
	};
});

const ORG = 'org_ramp_pace';

type Harness = ReturnType<typeof convexTest>;

async function seed(
	t: Harness,
	options: Omit<SeedRampCellOptions, 'organizationId'> = {}
): Promise<void> {
	await seedRampCell(t, { organizationId: ORG, ...options });
}

async function decision(t: Harness) {
	const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
	return rows[0];
}

describe('the pace dial is loaded, decided and WRITTEN by the cron', () => {
	it('writes the dial on an ordinary hold, and counts no UTC day', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 1, warming: { dailyCap: 1_000, sentToday: 900 } });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceMultiplier).toBe(1);
		// A hold is not an advance: the per-UTC-day anchor stays unset, so a later
		// tick the same day can still evaluate the day once (plan D19).
		expect(row?.paceLastEvaluatedUtcDay).toBeUndefined();
		expect(row?.paceFrozenUntil).toBeUndefined();
	});

	it('records BOTH actuators on the one audit row, interlock included (D12)', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 1, warming: { dailyCap: 1_000, sentToday: 900 } });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await decision(t);
		expect(row?.fromPaceMultiplier).toBe(1);
		expect(row?.toPaceMultiplier).toBe(1);
		expect(row?.paceDirection).toBe('hold');
		expect(row?.paceReason).toBeDefined();
		// Written by `composeActuators`, so its presence is proof the interlock ran
		// on the real decision rather than only in the pure suite.
		expect(row?.isPaceDeferred).toBe(false);
		// The gate inputs blob replays BOTH halves of the same tick.
		expect(JSON.parse(row?.snapshot ?? '{}')).toMatchObject({
			pace: { utilisation: { kind: 'measured', sent: 900, enforcedCap: 1_000 } },
		});
	});

	it('a HARD STOP retreats the pace dial too, and freezes it', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		await seed(t, {
			paceMultiplier: 1,
			warming: { dailyCap: 1_000, sentToday: 900 },
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: at }],
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		// The share goes to zero; the dial goes to its FLOOR rather than to nothing,
		// because a cap of nothing can never be re-measured.
		expect(row?.ownShare).toBe(0);
		expect(row?.paceMultiplier).toBe(PACE_AIMD.multiplierFloor);
		expect(row?.paceCleanStreak).toBe(0);
		expect(row?.paceFrozenUntil ?? 0).toBeGreaterThanOrEqual(at + RAMP_AIMD.blocklistFreezeMs);
		expect(row?.paceFreezeReason).toBe('dnsbl');

		const audited = await decision(t);
		expect(audited?.paceReason).toBe('dnsbl');
		expect(audited?.paceDirection).toBe('decrease');
	});

	it('the pace freeze is the dial’s OWN column, not the share’s', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			paceMultiplier: 1,
			// A share cooldown already running, from a gate breach hours ago.
			frozenUntil: Date.now() + 6 * 60 * 60 * 1000,
			freezeReason: 'gate_breach',
			warming: { dailyCap: 1_000, sentToday: 900 },
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		// The share is frozen; the pace dial is not, because nothing froze it.
		expect(row?.frozenUntil).toBeDefined();
		expect(row?.paceFrozenUntil).toBeUndefined();
	});

	it('a DEGENERATE stored dial is clamped and never stepped', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 99, warming: { dailyCap: 1_000, sentToday: 900 } });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceMultiplier).toBe(PACE_AIMD.multiplierCeiling);
		expect((await decision(t))?.paceReason).toBe('multiplier_unreadable');
	});

	it('a PAUSED controller writes no dial at all — pinned means pinned', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			isPaused: true,
			paceMultiplier: 0.5,
			warming: { dailyCap: 1_000, sentToday: 0 },
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceMultiplier).toBe(0.5);
		// It still EVALUATES and still audits, so an operator can watch what it
		// would have done.
		expect((await decision(t))?.paceReason).toBe('kill_switch');
	});

	it('NO warming state at all is a supported configuration, not an error (D2/D10)', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 1 });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceMultiplier).toBe(1);
		expect(row?.paceLastEvaluatedUtcDay).toBeUndefined();
		const audited = await decision(t);
		expect(audited?.paceDirection).toBe('hold');
		expect(JSON.parse(audited?.snapshot ?? '{}')).toMatchObject({
			pace: { utilisation: { kind: 'unknown' } },
		});
	});
});
