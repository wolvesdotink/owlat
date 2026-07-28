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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { loadWarmingCapacity } from '../warmingCapacity';
import { RAMP_FIXTURE_SHARE, readManagedCell, seedRampCell } from './rampCronFixtures';
import {
	CAPACITY_NOW,
	CAPACITY_ORG,
	capacityFor,
	DAY_MS,
	seedTrafficWeek,
	seedWarming,
	type CapacitySnapshot,
	type SeedWarmingOptions,
} from './capacityFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_capacity'),
	};
});

type Harness = ReturnType<typeof convexTest>;

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(CAPACITY_NOW);
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

	it('and holds the share where it was — a hold, never a retreat (plan D10)', async () => {
		const { harness } = await runTick({ traffic: false });
		expect((await readManagedCell(harness))?.ownShare).toBe(RAMP_FIXTURE_SHARE);
	});
});
