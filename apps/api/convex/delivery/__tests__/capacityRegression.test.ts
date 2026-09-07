/**
 * WHAT P3-3 DID NOT CHANGE.
 *
 * The piece adds a projection and a ceiling; it must not have touched the shipped
 * warming sync, the shipped capacity projection every campaign pre-flight already
 * depends on, or the plan's D2 rule that an absent reading constrains nothing.
 *
 * Three shipped absences answer `unconstrained` — no warming state, a sync that
 * has gone quiet, and a graduated pool with no cap to speak of — and in every one
 * of them the controller is bounded by its PHASE CEILING exactly as it was before
 * this piece landed. That is the whole of the D2 guarantee for this ceiling: a
 * fresh install with no MTA warming state behaves identically.
 *
 * THE ONE SANCTIONED CHANGE, pinned here and in `ramp/__tests__/capacityDegenerate`:
 * a deployment that HAS a warming cap but no projectable demand now HOLDS
 * (`capacity_unknown`) where the staged `unconstrained` stand-in previously let
 * the phase ceiling alone bind. That is the piece's point — the controller may not
 * ramp on volume it cannot measure — and it is a hold, never a retreat.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { DAY_MS } from '../../lib/constants';
import { campaignWarmingCapBinds } from '../../lib/sendProviders/warmingCapGate';
import { loadWarmingCapacity } from '../warmingCapacity';
import { capacityInputForCell, type RampCapacityContext } from '../rampCapacityInputs';
import { RAMP_FIXTURE_SHARE, readManagedCell, seedRampCell } from './rampCronFixtures';
import {
	CAPACITY_FROM,
	CAPACITY_NOW,
	CAPACITY_ORG,
	CAPACITY_TO,
	capacityFor,
	clearRelayEnv,
	resolveShippedRoute,
	seedOverflowRoute,
	seedTrafficWeek,
	seedWarming,
	spendWarmingCap,
	type CapacitySnapshot,
	type Harness,
	type SeedWarmingOptions,
} from './capacityFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_capacity'),
	};
});

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(CAPACITY_NOW);
});

afterEach(() => {
	clearRelayEnv();
});

async function runTick(options: {
	warming?: SeedWarmingOptions | 'absent';
	traffic?: boolean;
}): Promise<{ capacity: CapacitySnapshot; harness: Harness }> {
	const t = convexTest(schema, modules);
	await seedRampCell(t, { organizationId: CAPACITY_ORG });
	if (options.warming !== 'absent') await seedWarming(t, options.warming ?? {});
	if (options.traffic !== false) await seedTrafficWeek(t, 500);
	await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
	return { capacity: await capacityFor(t), harness: t };
}

describe('the shipped absences still constrain nothing (plan D2)', () => {
	it('NO warming state at all: unconstrained, exactly as before this piece', async () => {
		const { capacity } = await runTick({ warming: 'absent' });
		expect(capacity.kind).toBe('unconstrained');
	});

	it('a warming sync that has gone quiet for a day: unconstrained, never a spent cap', async () => {
		const { capacity } = await runTick({ warming: { syncedAgoMs: DAY_MS + 60_000 } });
		expect(capacity.kind).toBe('unconstrained');
	});

	it('a GRADUATED pool has no warming ceiling to bind against: unconstrained', async () => {
		const { capacity } = await runTick({ warming: { phase: 'graduated' } });
		expect(capacity.kind).toBe('unconstrained');
	});

	it('a fresh install — no warming state, no traffic — leaves the share exactly alone', async () => {
		const { harness } = await runTick({ warming: 'absent', traffic: false });
		expect((await readManagedCell(harness))?.ownShare).toBe(RAMP_FIXTURE_SHARE);
	});
});

describe('the shipped warming projection itself is untouched', () => {
	it("reports today's remaining headroom per active campaign IP", async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, { dailyCap: 5000, sentToday: 1000 });
		const projection = await t.run(
			async (ctx) => await loadWarmingCapacity(ctx, { now: CAPACITY_NOW })
		);
		expect(projection?.remainingToday).toBe(4000);
		expect(projection?.byDay[0]).toBe(4000);
	});

	it('still answers UNKNOWN — not zero — for a stale sync', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, { syncedAgoMs: DAY_MS + 60_000 });
		const projection = await t.run(
			async (ctx) => await loadWarmingCapacity(ctx, { now: CAPACITY_NOW })
		);
		expect(projection).toBeNull();
	});
});

describe('THE SANCTIONED CHANGE: a known cap over unprojectable demand HOLDS', () => {
	it('reads unknown rather than unconstrained when there is no trailing volume', async () => {
		const { capacity } = await runTick({ traffic: false });
		expect(capacity.kind).toBe('unknown');
	});

	it('and NAMES the reason, so the audit row says brand-new rather than merely "unknown"', async () => {
		// D12: an operator has to be able to learn WHICH degenerate case this is —
		// a cell that has never sent reads differently from a paused one.
		const { capacity } = await runTick({ traffic: false });
		expect(capacity.kind === 'unknown' ? capacity.reason : null).toBe('no_history');
	});

	it('and holds the share where it was — a hold, never a retreat (plan D10)', async () => {
		const { harness } = await runTick({ traffic: false });
		expect((await readManagedCell(harness))?.ownShare).toBe(RAMP_FIXTURE_SHARE);
	});
});

/**
 * THE SHIPPED REACTIVE HALF, UNCHANGED.
 *
 * P3-3 adds a PREDICTIVE ceiling beside the shipped `warmup_overflow` reroute
 * and rebuilds nothing of it. These pin the three points the piece composes with
 * — the resolver's reason, the pre-flight gate's verdict and the last-mile
 * forced-reason mapping — so a change to any of them fails here rather than
 * silently changing what the controller reads a reroute as.
 */
describe('the shipped warmup_overflow reroute is untouched', () => {
	async function seedOverflowDeployment(): Promise<Harness> {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: CAPACITY_ORG });
		await seedWarming(t);
		await seedOverflowRoute(t);
		return t;
	}

	it('a SPENT cap still relays with deliverabilityReason "warmup_overflow"', async () => {
		const t = await seedOverflowDeployment();
		await spendWarmingCap(t);
		const route = await resolveShippedRoute(t);
		expect(route?.providerType).toBe('ses');
		expect(route?.source).toBe('deliverability_fallback');
		expect(route?.deliverabilityReason).toBe('warmup_overflow');
	});

	it('and a cap with headroom still keeps the send on the own MTA', async () => {
		const t = await seedOverflowDeployment();
		const route = await resolveShippedRoute(t);
		expect(route?.providerType).toBe('mta');
		expect(route?.deliverabilityReason).toBeUndefined();
	});

	it('the pre-flight gate still answers "warmup_overflow_absorbs" rather than binding', async () => {
		const t = await seedOverflowDeployment();
		const verdict = await t.run(
			async (ctx) =>
				await campaignWarmingCapBinds(ctx, { fromEmail: CAPACITY_FROM, now: CAPACITY_NOW })
		);
		expect(verdict).toEqual({ binds: false, why: 'warmup_overflow_absorbs' });
	});

	it('the last-mile forced reason still resolves the relay with the same reason', async () => {
		// `delivery/lastMileRouting.ts` maps its own overflow decision onto
		// `forceRelayReason: 'warmup_overflow'` and asks this query. The forced
		// reason alone must carry the send to the relay — here with the cap NOT
		// spent, so nothing but the mapping can be producing the answer.
		const t = await seedOverflowDeployment();
		const relay = await t.query(internal.lib.sendProviders.route.resolveGovernedRelayRoute, {
			messageType: 'campaign',
			to: CAPACITY_TO,
			from: CAPACITY_FROM,
			forceRelayReason: 'warmup_overflow',
		});
		expect(relay.deferralCode).toBeUndefined();
		expect(relay.route?.providerType).toBe('ses');
		expect(relay.route?.deliverabilityReason).toBe('warmup_overflow');
	});
});

/**
 * THE READING IS NOT TAKEN FOR CELLS IT CANNOT BIND.
 *
 * `allDeliverabilityCells()` is stream-major, so a whole cursor slice can be
 * transactional — a stream the campaign warming pool does not carry and this
 * bound therefore says nothing about. Resolving the tick's context for such a
 * slice would pay for the `warmingState` row plus two index reads per governed
 * cell and discard all of it, so the context is passed in UNRESOLVED and the
 * stream check happens first.
 */
describe('P3-3 capacity reading laziness', () => {
	function countingContext(): { thunk: () => Promise<RampCapacityContext>; calls: () => number } {
		let calls = 0;
		return {
			thunk: async () => {
				calls += 1;
				return await Promise.resolve({ base: { kind: 'unconstrained' }, projections: new Map() });
			},
			calls: () => calls,
		};
	}

	it('never resolves the context for a cell the campaign pool does not carry', async () => {
		const context = countingContext();
		const input = await capacityInputForCell(
			context.thunk,
			{ stream: 'transactional', destinationProvider: 'gmail' },
			0.5
		);
		expect(input).toEqual({ kind: 'unconstrained' });
		expect(context.calls()).toBe(0);
	});

	it('resolves it exactly once for a cell the pool does carry', async () => {
		const context = countingContext();
		const input = await capacityInputForCell(
			context.thunk,
			{ stream: 'campaign', destinationProvider: 'gmail' },
			0.5
		);
		expect(input).toEqual({ kind: 'unconstrained' });
		expect(context.calls()).toBe(1);
	});
});
