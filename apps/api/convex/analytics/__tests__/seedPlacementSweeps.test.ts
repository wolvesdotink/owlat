/**
 * THE PROBE LEDGER, REDUCED TO PER-CELL SWEEPS — the reader gate 5 was missing.
 *
 * What this file pins is the READING RULES, over real rows through the real
 * window read: which probes are evidence, which cell they belong to, which arm
 * carried them, and how fresh the sweep is. The gate's own verdict is somebody
 * else's suite (`delivery/__tests__/seedGateWiring.test.ts` drives it end to
 * end); here the question is only whether the counts that reach it describe the
 * ledger.
 *
 * COUNTS, NEVER A RATE (D17): every assertion below is on integers.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import {
	SEED_PLACEMENT_WINDOW_MS,
	summarizeSeedPlacementSweeps,
	summarizeSeedPlacementWindow,
} from '../seedPlacement';
import { seedSweepsForCell, type SeedCellSweeps } from '../seedPlacementSweeps';
import { insertSeedProbes, type SeedHarness } from './seedProbeFixtures';
import { modules } from '../../__tests__/testModules';

const ORG = 'org_seed_sweeps';
const HOUR_MS = 60 * 60 * 1000;
const GMAIL_CAMPAIGN = { stream: 'campaign', destinationProvider: 'gmail' } as const;

/**
 * The sweeps for ONE cell. Resolved inside the transaction: the index is a Map,
 * and a Map is not a Convex value — carrying it out of `t.run` would fail on
 * serialization rather than on anything this suite is about.
 */
async function cellSweeps(
	t: SeedHarness,
	cell: DeliverabilityCell = GMAIL_CAMPAIGN
): Promise<SeedCellSweeps> {
	return await t.run(async (ctx) =>
		seedSweepsForCell(await summarizeSeedPlacementSweeps(ctx.db, ORG, Date.now()), cell)
	);
}

/** Every cell the ledger has evidence for, as canonical cell keys. */
async function sweptCells(t: SeedHarness): Promise<string[]> {
	return await t.run(async (ctx) => [
		...(await summarizeSeedPlacementSweeps(ctx.db, ORG, Date.now())).keys(),
	]);
}

async function probes(
	t: SeedHarness,
	options: Omit<Parameters<typeof insertSeedProbes>[1], 'organizationId'>
): Promise<void> {
	await insertSeedProbes(t, { organizationId: ORG, ...options });
}

describe('the sweep index counts the ledger, per cell and per arm', () => {
	it('counts each placement of the cell own arm', async () => {
		const t = convexTest(schema, modules);
		await probes(t, { count: 3, placement: 'inbox' });
		await probes(t, { count: 2, placement: 'category' });
		await probes(t, { count: 1, placement: 'spam' });
		await probes(t, { count: 1, placement: 'missing' });

		const own = (await cellSweeps(t)).own;
		expect(own).not.toBeNull();
		expect(own?.inbox).toBe(3);
		// The tab count survives the crossing: folding it into `inbox` on the way
		// in would be a second answer to "did this probe reach the recipient".
		expect(own?.category).toBe(2);
		expect(own?.spam).toBe(1);
		expect(own?.missing).toBe(1);
		expect(own?.deleted).toBe(0);
	});

	it('keeps the two arms apart', async () => {
		const t = convexTest(schema, modules);
		await probes(t, { count: 4, placement: 'spam' });
		await probes(t, { count: 5, placement: 'inbox', arm: 'reference' });

		const cell = await cellSweeps(t);
		expect(cell.own?.spam).toBe(4);
		expect(cell.own?.inbox).toBe(0);
		expect(cell.reference?.inbox).toBe(5);
	});

	it('reads an unattributed probe as the OWN arm', async () => {
		// Standalone is the default configuration: with no relay, every probe went
		// through our own MTA, and a row written before the arm was recorded must
		// not vanish from the arm under measurement.
		const t = convexTest(schema, modules);
		await probes(t, { count: 3, placement: 'inbox', unattributed: true });

		const cell = await cellSweeps(t);
		expect(cell.own?.inbox).toBe(3);
		expect(cell.reference).toBeNull();
	});

	it('keys the sweep by (stream, destinationProvider)', async () => {
		const t = convexTest(schema, modules);
		await probes(t, { count: 3, placement: 'inbox' });
		await probes(t, { count: 3, placement: 'spam', provider: 'yahoo' });

		expect((await sweptCells(t)).sort()).toEqual(
			[
				deliverabilityCellKey(GMAIL_CAMPAIGN),
				deliverabilityCellKey({ stream: 'campaign', destinationProvider: 'yahoo' }),
			].sort()
		);
		const yahoo = await cellSweeps(t, { stream: 'campaign', destinationProvider: 'yahoo' });
		expect(yahoo.own?.spam).toBe(3);
	});
});

describe('a row that is not evidence is counted as none', () => {
	it('leaves an unclassified probe out of both arms', async () => {
		const t = convexTest(schema, modules);
		await probes(t, { count: 5, placement: 'inbox', unclassified: true });

		// ABSENT, not a sweep of zeroes: the gate reads the two differently, and a
		// probe waiting on the poller is not an observation of anything.
		expect(await cellSweeps(t)).toEqual({ own: null, reference: null });
	});

	it('leaves a cell with nothing in the ledger absent on both arms', async () => {
		const t = convexTest(schema, modules);
		expect(await cellSweeps(t)).toEqual({ own: null, reference: null });
	});

	it('drops probes older than the placement window', async () => {
		const t = convexTest(schema, modules);
		await probes(t, {
			count: 6,
			placement: 'inbox',
			classifiedAgoMs: SEED_PLACEMENT_WINDOW_MS + HOUR_MS,
		});

		expect((await cellSweeps(t)).own).toBeNull();
	});
});

describe('the sweep carries the NEWEST observation in it', () => {
	it('stamps observedAt from the most recent classification', async () => {
		const t = convexTest(schema, modules);
		const before = Date.now();
		await probes(t, { count: 3, placement: 'inbox', classifiedAgoMs: 40 * HOUR_MS });
		await probes(t, { count: 3, placement: 'inbox', classifiedAgoMs: 2 * HOUR_MS });

		const own = (await cellSweeps(t)).own;
		expect(own?.inbox).toBe(6);
		// A cell that stopped being probed must go stale by the ramp own freshness
		// rule; anchoring on the oldest row would make a live sweep look stale, and
		// anchoring on a stale one would keep a dead sweep alive.
		expect(own?.observedAt).toBeGreaterThanOrEqual(before - 3 * HOUR_MS);
	});

	it('carries a window-old sweep on the strength of one recent probe', async () => {
		// THE RULE AT ITS SHARPEST, pinned because the controller now acts on it.
		// The counts span the whole 7-day placement window while the stamp is the
		// newest row, so nineteen six-day-old probes and one from an hour ago are
		// ONE fresh sweep of twenty — 95 % of the evidence older than the ramp
		// would act on alone. The verdict that comes out of it is pinned end to end
		// in `delivery/__tests__/seedGateWiring.test.ts`.
		const t = convexTest(schema, modules);
		const before = Date.now();
		await probes(t, { count: 19, placement: 'spam', classifiedAgoMs: 6 * 24 * HOUR_MS });
		await probes(t, { count: 1, placement: 'inbox' });

		const own = (await cellSweeps(t)).own;
		expect(own?.spam).toBe(19);
		expect(own?.inbox).toBe(1);
		expect(own?.observedAt).toBeGreaterThanOrEqual(before - 2 * HOUR_MS);
	});
});

describe('one ledger, one reading', () => {
	it('counts the same probes the provider roll-up counts', async () => {
		const t = convexTest(schema, modules);
		await probes(t, { count: 7, placement: 'inbox' });
		await probes(t, { count: 3, placement: 'spam' });
		// Not evidence for either reader.
		await probes(t, { count: 4, placement: 'inbox', unclassified: true });

		const { rollup, own } = await t.run(async (ctx) => {
			const now = Date.now();
			const summary = await summarizeSeedPlacementWindow(ctx.db, ORG, now);
			const index = await summarizeSeedPlacementSweeps(ctx.db, ORG, now);
			return {
				rollup: summary.rollups.find((entry) => entry.provider === 'gmail'),
				own: seedSweepsForCell(index, GMAIL_CAMPAIGN).own,
			};
		});

		// The screen roll-up and the controller sweep are two answers derived from
		// one read; a sample size that differed would mean the two could disagree
		// about the same window (ADR-0042).
		expect(rollup?.sampleSize).toBe(10);
		expect((own?.inbox ?? 0) + (own?.spam ?? 0)).toBe(10);
	});
});
