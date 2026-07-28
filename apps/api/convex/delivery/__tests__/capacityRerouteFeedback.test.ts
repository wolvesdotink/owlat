/**
 * THE PREDICTIVE CEILING AND THE SHIPPED REACTIVE REROUTE, COMPOSED.
 *
 * The reactive half already ships: a send that would exceed the warming cap is
 * handed to the relay with `deliverabilityReason: 'warmup_overflow'`
 * (`lib/sendProviders/warmingCapGate.ts`). This piece adds the predictive half so
 * most of that overflow is never assigned to the own MTA in the first place. The
 * two have to compose, and this file asserts the composition end to end — through
 * the real cron, the real tables and the real audit row:
 *
 *   1. A REROUTE IS A MISS THE CONTROLLER CAN SEE. The overflow send is recorded
 *      under the arm that actually carried it, so a rerouted day leaves the cell's
 *      trailing OWN volume below the share it was assigned. That shortfall reaches
 *      the `mixDecisions` snapshot as `missRate` (plan D12) — evidence an operator
 *      can read, never a rung.
 *   2. AND IT LOWERS THE NEXT PROJECTION of what the own arm will carry.
 *   3. BUT IT MUST NOT RAISE THE CEILING. That is the runaway loop the design has
 *      to avoid: were the ceiling divided by the OWN arm's volume, every reroute
 *      would lower the denominator, raise the allowed share, assign still more
 *      traffic to a cap that had just refused it, and reroute harder. The
 *      denominator is DEMAND — both arms — so a reroute moves volume between arms
 *      and moves the ceiling not at all.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { seedRampCell } from './rampCronFixtures';
import {
	CAPACITY_NOW,
	CAPACITY_ORG,
	capacityFor,
	seedTrafficWeek,
	seedWarming,
	type CapacitySnapshot,
} from './capacityFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_capacity'),
	};
});

/** The share the fixture cell is assigned — half its traffic to the own MTA. */
const ASSIGNED_SHARE = 0.5;

// A FIXED CLOCK, or the suite would be a time bomb: the capacity reading is
// deliberately unusable in the last minutes of a UTC day, so a real clock would
// make these assertions fail for ~70 minutes out of every 24 hours.
beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(CAPACITY_NOW);
});

/** A deployment sending 1000 a day through one cell, `ownPerDay` of it via the MTA. */
async function runWeek(ownPerDay: number): Promise<CapacitySnapshot> {
	const t = convexTest(schema, modules);
	await seedRampCell(t, { organizationId: CAPACITY_ORG, ownShare: ASSIGNED_SHARE });
	await seedWarming(t);
	await seedTrafficWeek(t, ownPerDay);
	await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
	return await capacityFor(t);
}

describe('a shipped warmup_overflow reroute reaches the controller as a miss', () => {
	it('records no miss when the own arm carried the share it was assigned', async () => {
		const capacity = await runWeek(500);
		expect(capacity.kind).toBe('projected');
		expect(capacity.cellEvidence?.ownFraction ?? -1).toBeCloseTo(0.5, 10);
		expect(capacity.cellEvidence?.missRate).toBe(0);
		expect(capacity.cellEvidence?.observedDays).toBe(7);
	});

	it('records the shortfall when the cap rerouted most of the own arm away', async () => {
		// 300 of the 500 sends assigned to the own MTA were rerouted to the relay.
		const capacity = await runWeek(200);
		expect(capacity.cellEvidence?.ownFraction ?? -1).toBeCloseTo(0.2, 10);
		// (0.5 - 0.2) / 0.5 — three fifths of the assigned own traffic never reached
		// the own MTA.
		expect(capacity.cellEvidence?.missRate ?? -1).toBeCloseTo(0.6, 10);
	});

	it('LOWERS the projection of what the own arm will carry', async () => {
		const carried = await runWeek(500);
		const rerouted = await runWeek(200);
		expect(rerouted.cellEvidence?.ownFraction ?? 1).toBeLessThan(
			carried.cellEvidence?.ownFraction ?? 0
		);
	});

	it('but does NOT raise the ceiling — the denominator is DEMAND, not the own arm', async () => {
		const carried = await runWeek(500);
		const rerouted = await runWeek(200);
		// Same demand, same headroom, same ceiling: a reroute cannot buy the cell a
		// larger share of the cap that just refused it.
		expect(rerouted.projectedVolume ?? -1).toBeCloseTo(carried.projectedVolume ?? 0, 10);
		expect(rerouted.warmingCapRemaining).toBe(carried.warmingCapRemaining);
		expect(rerouted.cellEvidence?.projectedCellVolume ?? -1).toBeCloseTo(
			carried.cellEvidence?.projectedCellVolume ?? 0,
			10
		);
	});

	it('projects the DEPLOYMENT demand for the rest of today against the remaining cap', async () => {
		const capacity = await runWeek(500);
		// One cell sending 1000 a day, read at 08:00 UTC: two thirds of it ahead.
		expect(capacity.projectedVolume ?? -1).toBeCloseTo(1000 * (2 / 3), 6);
		// 5000 cap less the 1000 already sent today.
		expect(capacity.warmingCapRemaining).toBe(4000);
	});
});
