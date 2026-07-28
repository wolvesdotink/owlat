/**
 * SHARED FIXTURES for the capacity-ceiling suites (P3-3).
 *
 * Both suites need the same four things — a fixed clock, a warming state, a week
 * of cell traffic split across the two arms, and the capacity blob out of the
 * audit row — and they must not drift apart: the reroute suite asserts what the
 * numbers MEAN, the regression suite asserts which shipped absences still answer
 * `unconstrained`, and a fixture that disagreed between them would make one of
 * the two lie.
 */

import type { convexTest } from 'convex-test';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../../analytics/transportOutcomeSummary';

export const CAPACITY_ORG = 'org_ramp_capacity';
export const DAY_MS = 24 * 60 * 60 * 1000;
/** 08:00 UTC on a fixed day: two thirds of the UTC day still ahead. */
export const CAPACITY_NOW = 1_800_000_000_000;
export const CAPACITY_TODAY = CAPACITY_NOW - (CAPACITY_NOW % DAY_MS);
export const CAPACITY_CELL = deliverabilityCellKey({
	stream: 'campaign',
	destinationProvider: 'gmail',
});

type Harness = ReturnType<typeof convexTest>;

export interface CapacityEvidence {
	readonly projectedCellVolume: number;
	readonly observedDays: number;
	readonly ownFraction: number;
	readonly missRate: number | null;
}

/** The `capacity` member of a `mixDecisions` snapshot blob. */
export interface CapacitySnapshot {
	readonly kind: string;
	readonly reason?: string;
	readonly warmingCapRemaining?: number;
	readonly projectedVolume?: number;
	readonly cellEvidence?: CapacityEvidence;
}

/**
 * One day of the cell's traffic, split across the two arms exactly as the router
 * would have written it: the own arm gets what the MTA carried, the reference arm
 * gets the assigned relay traffic AND anything the warming cap rerouted.
 */
export async function seedTrafficDay(
	t: Harness,
	args: { dayOffset: number; own: number; reference: number }
): Promise<void> {
	const periodStart = CAPACITY_TODAY - args.dayOffset * DAY_MS;
	await t.run(async (ctx) => {
		for (const [arm, sent] of [
			['own', args.own],
			['reference', args.reference],
		] as const) {
			await ctx.db.insert('transportOutcomes', {
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				organizationId: CAPACITY_ORG,
				cell: CAPACITY_CELL,
				arm,
				periodStart,
				shardKey: 0,
				sent,
				delivered: sent,
				lastRecordedAt: periodStart + DAY_MS - 1,
			});
		}
	});
}

export interface SeedWarmingOptions {
	/** Overall pool phase; `'graduated'` is the shipped "no cap at all" answer. */
	readonly phase?: 'ramp' | 'plateau' | 'graduated';
	/** How long before the fixed clock the MTA last synced. */
	readonly syncedAgoMs?: number;
	readonly dailyCap?: number;
	readonly sentToday?: number;
}

/** One active campaign IP, with headroom left today unless told otherwise. */
export async function seedWarming(t: Harness, options: SeedWarmingOptions = {}): Promise<void> {
	const phase = options.phase ?? 'ramp';
	const dailyCap = options.dailyCap ?? 5000;
	const sentToday = options.sentToday ?? 1000;
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase,
			totalDailyCap: dailyCap,
			totalSentToday: sentToday,
			ipCount: 1,
			ips: [
				{
					ip: '203.0.113.20',
					phase,
					currentDay: 8,
					dailyCap,
					sentToday,
					bounceRate: 0,
					deferralRate: 0,
					pool: 'campaign',
					active: true,
				},
			],
			syncedAt: CAPACITY_NOW - (options.syncedAgoMs ?? 60_000),
		});
	});
}

/** The capacity blob the controller actually decided against, off the audit row. */
export async function capacityFor(t: Harness): Promise<CapacitySnapshot> {
	const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
	const row = rows.find((decision) => decision.cell === CAPACITY_CELL);
	if (!row) throw new Error('no decision recorded for the cell');
	const snapshot = JSON.parse(String(row.snapshot)) as { capacity: CapacitySnapshot };
	return snapshot.capacity;
}

/** Seven complete days at a fixed demand of 1000 sends a day, split by `ownPerDay`. */
export async function seedTrafficWeek(t: Harness, ownPerDay: number): Promise<void> {
	for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
		await seedTrafficDay(t, { dayOffset, own: ownPerDay, reference: 1000 - ownPerDay });
	}
}
