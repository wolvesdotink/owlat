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
 * AND WHICH DIAL THE CRON DRIVES AT ALL. The substitution table (P3-8's
 * `ramp/degradation.ts`) answers that, and the cron consults it through the read
 * half's resolution — so the ACTUATOR SELECTION is pinned here, at the boundary
 * the cron actually reads it from. Without it the composition interlock is
 * handed a live share decision on a deployment that has no share to move, and
 * the pace dial — the only dial such a deployment owns — is held back for a
 * whole evaluation window every time the share steps.
 *
 * WHAT IS DELIBERATELY NOT HERE: a pace INCREASE through the cron. The increase
 * ladder itself is exhaustively fixture-pinned in
 * `ramp/__tests__/paceActuator.test.ts`.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { PACE_AIMD } from '../ramp/paceConfig';
import {
	readManagedCell,
	seedArmOutcomes,
	seedRampCell,
	type Harness,
	type SeedRampCellOptions,
} from './rampCronFixtures';
import { loadCellInput } from '../rampControllerInputs';
import { loadRampDeploymentPresence } from '../rampIntegrationPresence';
import { loadRampCapacityContext } from '../rampCapacityInputs';
import { loadStreamlessRouteState } from '../../lib/deliverabilityRouteState';
import { modules } from '../../__tests__/testModules';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_pace'),
	};
});

const ORG = 'org_ramp_pace';

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

/**
 * WHICH ACTUATOR THE CRON SELECTS for the campaign/gmail cell, read the way the
 * cron reads it: off the resolution `loadCellInput` returns, not off a second
 * fold that could disagree with the constants the tick was built from.
 */
async function selectedActuator(t: Harness): Promise<'share' | 'pace'> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const pool = await loadStreamlessRouteState(ctx, ORG, 'all');
		const presence = await loadRampDeploymentPresence(ctx, { organizationId: ORG, now });
		const loaded = await loadCellInput(ctx, {
			organizationId: ORG,
			cell: { stream: 'campaign', destinationProvider: 'gmail' },
			pool,
			capacity: async () => await loadRampCapacityContext(ctx, { organizationId: ORG, now }),
			presence,
			isKillSwitchEngaged: false,
			isSendingPermitted: true,
			now,
		});
		if (loaded === null) throw new Error('the seeded cell is not ramp-managed');
		return loaded.degradation.actuator;
	});
}

describe('the cron selects the actuator from the substitution table (D3)', () => {
	it('a deployment with NO reference transport drives the PACE dial', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 1, warming: { dailyCap: 1_000, sentToday: 900 } });
		// Own traffic only — a zero-third-party deployment, which is a SUPPORTED
		// configuration and not a degraded one (plan D2). This is the exact
		// configuration the standalone twin exists for.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });

		expect(await selectedActuator(t)).toBe('pace');
	});

	it('a live reference arm hands the cell back to the SHARE dial', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { paceMultiplier: 1, warming: { dailyCap: 1_000, sentToday: 900 } });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 800 });

		expect(await selectedActuator(t)).toBe('share');
	});

	// THE CONSEQUENCE OF THE SELECTION, on the row the cron writes: a standalone
	// cell hands `composeActuators` no share, so the interlock has nothing to
	// interlock and can never stamp the deferral anchor that would hold the pace
	// ladder for a whole share evaluation window.
	it('a standalone cell is never deferred by a share it does not control', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			paceMultiplier: 1,
			paceCleanStreak: 3,
			warming: { dailyCap: 1_000, sentToday: 900 },
		});
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceDeferredAt).toBeUndefined();
		const audited = await decision(t);
		expect(audited?.isPaceDeferred).toBe(false);
		expect(audited?.paceReason).not.toBe('share_moved_first');
	});
});

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

	// THE STALE-BUT-EXERCISED READING. `sentToday` / `dailyCap` reset at the UTC
	// boundary, so a warming row from hours ago describes a day that is over — and
	// a 900/1000 reading from it would otherwise satisfy `isCapExercised` and buy
	// today's +STEP. The rule the one sanctioned D19 change exists to enforce is
	// that an unexercised cap is not evidence, so a broken measurement pipe must
	// read `unknown` and HOLD (plan D10).
	it('a STALE warming reading is unknown even when it looks exercised, and holds', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			paceMultiplier: 1,
			paceCleanStreak: 3,
			warming: { dailyCap: 1_000, sentToday: 900 },
			warmingAgeMs: 2 * 60 * 60 * 1000,
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		expect(row?.paceMultiplier).toBe(1);
		// And the day stays UNCOUNTED, so the tick after the pipe recovers can
		// still evaluate this day once.
		expect(row?.paceLastEvaluatedUtcDay).toBeUndefined();
		expect(JSON.parse((await decision(t))?.snapshot ?? '{}')).toMatchObject({
			pace: { utilisation: { kind: 'unknown' } },
		});
	});

	// A FRESH reading of the same shape is the control for the fixture above: the
	// only thing that changed is the age of the snapshot.
	it('the same reading, fresh, is measured evidence', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			paceMultiplier: 1,
			paceCleanStreak: 3,
			warming: { dailyCap: 1_000, sentToday: 900 },
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		expect(JSON.parse((await decision(t))?.snapshot ?? '{}')).toMatchObject({
			pace: { utilisation: { kind: 'measured', sent: 900, enforcedCap: 1_000 } },
		});
	});

	// THE INTERLOCK OUTLIVES THE TICK THAT FIRED IT (plan D3). The cron ticks
	// hourly against a day-long share window, so the withheld step has to stay
	// withheld across ticks — the pure suite pins the rule, this pins the column.
	it('the deferral anchor survives a tick that did not fire the interlock', async () => {
		const t = convexTest(schema, modules);
		const deferredAt = Date.now() - 60 * 60 * 1000;
		await seed(t, {
			paceMultiplier: 1,
			paceCleanStreak: 3,
			paceDeferredAt: deferredAt,
			warming: { dailyCap: 1_000, sentToday: 900 },
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await readManagedCell(t);
		// STAMPED ONLY BY THE INTERLOCK, and never cleared by an ordinary tick: the
		// rung that reads it is written against elapsed time, so a tick that did not
		// defer anything must leave the anchor exactly where it found it. Losing it
		// here is how the withheld step would be taken an hour later instead of a
		// window later. (The rung's own behaviour is pinned in the pure suite,
		// `ramp/__tests__/actuatorComposition.test.ts`, where a gate verdict can be
		// made green.)
		expect(row?.paceDeferredAt).toBe(deferredAt);
		expect(row?.paceMultiplier).toBe(1);
		expect(row?.paceLastEvaluatedUtcDay).toBeUndefined();
	});

	// D12: EVERY DECREASE emits an admin notification naming the gate that broke.
	// A pace-only retreat is reachable because the two dials keep separate freeze
	// columns: the share sits inside an earlier cooldown and holds, while the pace
	// dial — whose own freeze has expired — halves on the same breach.
	it('a PACE-ONLY retreat still produces an admin notice', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		await seed(t, {
			paceMultiplier: 1,
			// The SHARE is frozen by an earlier cooldown, so it can only hold.
			frozenUntil: at + 6 * 60 * 60 * 1000,
			freezeReason: 'gate_breach',
			warming: { dailyCap: 1_000, sentToday: 900 },
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: at }],
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const audited = await decision(t);
		expect(audited?.direction).toBe('decrease');
		expect(audited?.paceDirection).toBe('decrease');
		const notice = audited?.adminNotice ?? '';
		// The notice names the pace dial and the cause, not only the share's.
		expect(notice).toContain('warm-up pace');
		expect(notice).toContain('blocklist');
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
