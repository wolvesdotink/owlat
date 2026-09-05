/**
 * THE PREDICTIVE CEILING AND THE SHIPPED REACTIVE REROUTE, COMPOSED.
 *
 * The reactive half already ships: a send that would exceed the warming cap is
 * handed to the relay with `deliverabilityReason: 'warmup_overflow'`
 * (`lib/sendProviders/routing.ts`, gated by `lib/sendProviders/warmingCapGate.ts`).
 * This piece adds the predictive half so most of that overflow is never assigned
 * to the own MTA in the first place. The two have to compose, and this file
 * asserts the composition end to end.
 *
 * THE CHAIN IS EXECUTED, NOT MODELLED. The first suite runs the SHIPPED
 * resolver against a real spent cap, takes the arm from the shipped
 * `armForTransport`, and records the outcome through the shipped
 * `recordTransportOutcomeForCell`. Nothing between the overflow verdict and the
 * row the controller reads is a fixture's assumption:
 *
 *   resolveSendRouteFromDb -> deliverabilityReason 'warmup_overflow'
 *     -> providerType 'ses' -> armForTransport(...) === 'reference'
 *     -> transportOutcomes(reference) -> the controller's cell evidence.
 *
 * The properties that follow are then asserted over a whole week:
 *
 *   1. A REROUTE IS A SHORTFALL THE CONTROLLER CAN SEE — the own arm did not
 *      carry the share the cell is set to, and that reaches the `mixDecisions`
 *      snapshot (plan D12) as evidence an operator can read, never as a rung.
 *   2. AND IT LOWERS THE PROJECTION of what the own arm will carry.
 *   3. BUT IT MUST NOT RAISE THE CEILING. That is the runaway loop the design
 *      has to avoid: were the ceiling divided by the OWN arm's volume, every
 *      reroute would lower the denominator, raise the allowed share, assign
 *      still more traffic to a cap that had just refused it, and reroute harder.
 *      The denominator is DEMAND — both arms — so a reroute moves volume between
 *      arms and moves the ceiling not at all.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { recordTransportOutcomeForCell } from '../../analytics/transportOutcomes';
import { armForTransport } from '../sendAssignments';
import type { SendProviderKind } from '../../lib/sendProviders/types';
import { DAY_MS } from '../../lib/constants';
import { seedRampCell } from './rampCronFixtures';
import {
	CAPACITY_CELL,
	CAPACITY_NOW,
	CAPACITY_ORG,
	CAPACITY_TODAY,
	clearRelayEnv,
	projectedCapacityFor,
	refillWarmingCap,
	resolveShippedRoute,
	seedOverflowRoute,
	seedTrafficWeek,
	seedWarming,
	spendWarmingCap,
	type Harness,
	type ProjectedCapacity,
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

afterEach(() => {
	clearRelayEnv();
});

/** A deployment sending 1000 a day through one cell, `ownPerDay` of it via the MTA. */
async function runWeek(ownPerDay: number): Promise<ProjectedCapacity> {
	const t = convexTest(schema, modules);
	await seedRampCell(t, { organizationId: CAPACITY_ORG, ownShare: ASSIGNED_SHARE });
	await seedWarming(t);
	await seedTrafficWeek(t, ownPerDay);
	await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
	return await projectedCapacityFor(t);
}

/** Record `sends` outcomes for one complete day through the SHIPPED writer. */
async function recordDay(
	t: Harness,
	args: { dayOffset: number; transport: SendProviderKind; sends: number }
): Promise<void> {
	const at = CAPACITY_TODAY - args.dayOffset * DAY_MS + 1;
	await t.run(async (ctx) => {
		for (let index = 0; index < args.sends; index += 1) {
			await recordTransportOutcomeForCell(ctx, {
				organizationId: CAPACITY_ORG,
				cell: CAPACITY_CELL,
				// THE ARM COMES FROM THE SHIPPED MAPPING, so a change to it changes
				// this fixture's answer instead of leaving it pinned to a stale one.
				arm: armForTransport(args.transport),
				event: 'sent',
				isCalibration: false,
				now: at,
			});
		}
	});
}

describe('the SHIPPED warmup_overflow reroute is what files the send under the reference arm', () => {
	it('resolves to the own MTA while the cap has headroom, and to the relay once it is spent', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: CAPACITY_ORG, ownShare: ASSIGNED_SHARE });
		await seedWarming(t);
		await seedOverflowRoute(t);

		const carried = await resolveShippedRoute(t);
		expect(carried?.providerType).toBe('mta');
		expect(carried?.deliverabilityReason).toBeUndefined();

		await spendWarmingCap(t);
		const overflowed = await resolveShippedRoute(t);
		// The shipped reactive half, executed: same configuration, same resolver,
		// a spent cap — and the relay carries the send with the overflow reason.
		expect(overflowed?.providerType).toBe('ses');
		expect(overflowed?.source).toBe('deliverability_fallback');
		expect(overflowed?.deliverabilityReason).toBe('warmup_overflow');

		// AND THAT VERDICT IS WHAT PUTS THE SEND IN THE REFERENCE ARM. This is the
		// link the controller's whole reading of a reroute depends on.
		expect(armForTransport(carried?.providerType ?? 'ses')).toBe('own');
		expect(armForTransport(overflowed?.providerType ?? 'mta')).toBe('reference');
	});

	it('reaches the controller as a shortfall against the share the cell is set to', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: CAPACITY_ORG, ownShare: ASSIGNED_SHARE });
		await seedWarming(t);
		await seedOverflowRoute(t);

		// Resolve ONCE per state, then let the resolver's own verdict decide which
		// arm each day's volume is recorded under.
		const carried = await resolveShippedRoute(t);
		await spendWarmingCap(t);
		const overflowed = await resolveShippedRoute(t);
		if (!carried || !overflowed) throw new Error('the shipped resolver produced no route');

		for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
			// Ten of every fifty sends stayed on the MTA; the cap rerouted the rest.
			await recordDay(t, { dayOffset, transport: carried.providerType, sends: 10 });
			await recordDay(t, { dayOffset, transport: overflowed.providerType, sends: 40 });
		}

		// Give the cap headroom again so the tick has a real ceiling to compute —
		// the reading, not the reroute, is what is under test from here.
		await refillWarmingCap(t);
		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const capacity = await projectedCapacityFor(t);
		expect(capacity.cellEvidence?.ownFraction ?? -1).toBeCloseTo(0.2, 10);
		// (0.5 - 0.2) / 0.5 — three fifths of what the cell is set to send through
		// the own MTA did not go through it.
		expect(capacity.cellEvidence?.deliveredShareShortfall ?? -1).toBeCloseTo(0.6, 10);
	});
});

describe('the composition, over a whole week of traffic', () => {
	it('records no shortfall when the own arm carried the share it was assigned', async () => {
		const capacity = await runWeek(500);
		expect(capacity.cellEvidence?.ownFraction ?? -1).toBeCloseTo(0.5, 10);
		expect(capacity.cellEvidence?.deliveredShareShortfall).toBe(0);
		expect(capacity.cellEvidence?.observedDays).toBe(7);
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
		expect(rerouted.projectedVolume).toBeCloseTo(carried.projectedVolume, 10);
		expect(rerouted.warmingCapRemaining).toBe(carried.warmingCapRemaining);
		expect(rerouted.cellEvidence?.projectedCellVolume ?? -1).toBeCloseTo(
			carried.cellEvidence?.projectedCellVolume ?? 0,
			10
		);
	});

	it('projects the DEPLOYMENT demand for the rest of today against the remaining cap', async () => {
		const capacity = await runWeek(500);
		// One cell sending 1000 a day, read at 08:00 UTC: two thirds of it ahead.
		expect(capacity.projectedVolume).toBeCloseTo(1000 * (2 / 3), 6);
		// 5000 cap less the 1000 already sent today.
		expect(capacity.warmingCapRemaining).toBe(4000);
	});
});
