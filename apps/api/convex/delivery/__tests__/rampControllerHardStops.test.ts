/**
 * THE HARD STOPS, END TO END THROUGH THE CRON.
 *
 * The pure suites prove each hard-stop BRANCH is correct. This file proves each
 * branch is REACHABLE: that the signals the MTA actually writes, onto the rows
 * it actually writes them to, arrive at the decision function as the booleans it
 * expects — and that the resulting share, freeze, audit row and admin notice all
 * land on disk.
 *
 * The rung that motivated the file: every pool-level blocklist / quarantine
 * signal is reported against `provider: 'all'` and is therefore filed on the
 * POOL row, not on any cell's row. A controller reading only the cell's rows
 * would see a hard stop that can never fire, with every pure fixture still
 * green. Wiring is not covered by the fixtures that inject the booleans.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../deliverabilityRouting';
import { cleanEvaluation } from '../ramp/__tests__/controllerFixtures';
import {
	RAMP_FIXTURE_SHARE,
	readManagedCell,
	seedRampCell,
	type SeedRampCellOptions,
} from './rampCronFixtures';
import { modules } from '../../__tests__/testModules';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_hard_stops'),
	};
});

const ORG = 'org_ramp_hard_stops';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CELL_SHARE = RAMP_FIXTURE_SHARE;

type Harness = ReturnType<typeof convexTest>;

type SeedOptions = Omit<SeedRampCellOptions, 'organizationId'>;

async function seed(t: Harness, options: SeedOptions = {}): Promise<void> {
	await seedRampCell(t, { organizationId: ORG, ...options });
}

const cellRow = readManagedCell;

async function decisions(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
}

describe('hard stops reach the controller through real route-state rows', () => {
	it('a CRITICAL pool blocklist listing zeroes the cell and freezes it for a day', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		// Filed on the POOL row, exactly as the MTA's /ip-reputation sync does.
		await seed(t, {
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: at }],
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.ownShare).toBe(0);
		expect(row?.isFallbackActive).toBe(true);
		expect(row?.frozenUntil ?? 0).toBeGreaterThanOrEqual(at + RAMP_AIMD.blocklistFreezeMs);
		// A hard stop does NOT advance the gate-cooldown ladder.
		expect(row?.cooldownMs).toBeUndefined();
		expect(row?.cleanStreak).toBe(0);

		const rows = await decisions(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toBe('dnsbl');
		expect(rows[0]?.direction).toBe('decrease');
		expect(rows[0]?.adminNotice).toContain('blocklist');

		const auditLogs = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(auditLogs).toHaveLength(1);
		expect(auditLogs[0]?.action).toBe('deliverability_ramp.share_changed');
	});

	it('a WARNING listing on the pool is not a hard stop', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			poolSignals: [{ source: 'dnsbl_listed', severity: 'warning', observedAt: Date.now() }],
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		expect((await cellRow(t))?.ownShare).toBe(CELL_SHARE);
		expect((await decisions(t))[0]?.reason).toBe('holding');
	});

	// ONE DEFINITION OF "STILL TRUE". The shipped router stops acting on a route
	// state it has not heard from inside the signal-age window; a controller that
	// kept acting on the same row would let a signal that went stale rather than
	// being cleared walk the cell toward zero over successive 6h freezes.
	it('ignores a critical listing on a route state the router has already aged out', async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: Date.now() }],
			poolAgeMs: DELIVERABILITY_SIGNAL_MAX_AGE_MS + 60_000,
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.ownShare).toBe(CELL_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		expect((await decisions(t))[0]?.reason).toBe('holding');
	});

	// AN EXPIRED FREEZE IS NOT A FREEZE. The rung already ignores a past instant,
	// so leaving it on the row changes no decision — it only leaves every reader
	// of the row (the delivery dashboard, the `mix` blob in the audit snapshot)
	// saying "frozen until <a moment last week>" for ever. The cooldown LADDER, by
	// contrast, is the rung position and its repeat-window anchor: it must survive.
	it('clears an expired freeze instant off the row while keeping the cooldown ladder', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		await seed(t, { frozenUntil: at - HOUR_MS, cooldownMs: RAMP_AIMD.cooldownBaseMs });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.frozenUntil).toBeUndefined();
		expect(row?.cooldownMs).toBe(RAMP_AIMD.cooldownBaseMs);
		expect(row?.ownShare).toBe(CELL_SHARE);
		expect((await decisions(t))[0]?.reason).toBe('holding');
	});

	it('keeps a freeze instant that has NOT yet expired', async () => {
		const t = convexTest(schema, modules);
		const until = Date.now() + 3 * HOUR_MS;
		await seed(t, { frozenUntil: until });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.frozenUntil).toBe(until);
		expect((await decisions(t))[0]?.reason).toBe('frozen');
	});

	it('an open circuit breaker on the cell provider halves the share and freezes 6h', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		await seed(t, {
			providerSignals: [{ source: 'breaker_open', severity: 'critical', observedAt: at }],
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.ownShare).toBe(CELL_SHARE / 2);
		expect(row?.frozenUntil ?? 0).toBeGreaterThanOrEqual(at + RAMP_AIMD.breakerFreezeMs);
		expect(row?.frozenUntil ?? 0).toBeLessThan(at + 7 * HOUR_MS);
		expect(row?.cooldownMs).toBeUndefined();

		const rows = await decisions(t);
		expect(rows[0]?.reason).toBe('breaker');
		expect(rows[0]?.adminNotice).toContain('circuit breaker');
	});

	it('a breaker freeze leaves the gate-cooldown ladder and its anchor alone', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		const anchor = at - 30 * HOUR_MS;
		await seed(t, {
			providerSignals: [{ source: 'breaker_open', severity: 'critical', observedAt: at }],
		});
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			const cell = rows.find((row) => row.stream === 'campaign');
			if (cell) {
				await ctx.db.patch(cell._id, { fallbackActiveSince: anchor, cooldownMs: 6 * HOUR_MS });
			}
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		// Re-stamping the anchor here would re-arm the ladder's 24h repeat window,
		// so the NEXT gate breach would double off a stale rung.
		expect(row?.fallbackActiveSince).toBe(anchor);
		expect(row?.cooldownMs).toBe(6 * HOUR_MS);
		expect(row?.frozenUntil ?? 0).toBeGreaterThanOrEqual(at + RAMP_AIMD.breakerFreezeMs);
	});

	it('a non-sending abuse status stops the cell outright', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { abuseStatus: 'suspended' });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.ownShare).toBe(0);
		expect(row?.frozenUntil).toBeUndefined();

		const rows = await decisions(t);
		expect(rows[0]?.reason).toBe('abuse_status');
		expect(rows[0]?.adminNotice).toContain('abuse status');
	});

	it('an ordinary tick leaves the cell where it is and writes no notice', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = await cellRow(t);
		expect(row?.ownShare).toBe(CELL_SHARE);
		// The mix GENERATION never moves on an ordinary evaluation (plan D7).
		expect(row?.mixVersion).toBe(2);
		const rows = await decisions(t);
		expect(rows[0]?.adminNotice).toBeUndefined();
	});

	it('does nothing at all when no organization is configured', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const sessionOrganization = await import('../../lib/sessionOrganization');
		vi.mocked(sessionOrganization.getSingletonOrganizationId).mockRejectedValueOnce(
			new Error('No organization configured on this Owlat instance')
		);

		const result = await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		expect(result).toEqual({ evaluated: 0, done: true });
		expect(await decisions(t)).toHaveLength(0);
		expect((await cellRow(t))?.ownShare).toBe(CELL_SHARE);
	});
});

/**
 * A DEGENERATE STORED SHARE, END TO END. The pure suite proves the rung; this
 * proves the shell does not sand the input off before the rung can see it —
 * every routing reader clamps a stored share, and a controller handed the
 * clamped value would read `-0.5` as a perfectly ordinary 0 and add to it.
 */
describe('a stored share that is not a share', () => {
	const cases: readonly {
		readonly label: string;
		readonly stored: number;
		readonly held: number;
	}[] = [
		{ label: 'NaN', stored: Number.NaN, held: 0 },
		{ label: 'negative', stored: -0.5, held: 0 },
		{ label: 'above one', stored: 1.5, held: 1 },
	];

	for (const { label, stored, held } of cases) {
		it(`holds a ${label} share at the clamped value and never steps it up`, async () => {
			const t = convexTest(schema, modules);
			await seed(t, { ownShare: stored });

			await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

			const row = await cellRow(t);
			expect(row?.ownShare).toBe(held);
			// Never above the clamped reading, and never a graduation clock started
			// off a value we could not read.
			expect(row?.ownShare ?? 0).toBeLessThanOrEqual(held);
			expect(row?.graduatedAt).toBeUndefined();
			expect(row?.healthySince).toBeUndefined();

			const rows = await decisions(t);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.reason).toBe('share_unreadable');
			expect(rows[0]?.direction).toBe('hold');
		});
	}
});

/**
 * EVIDENCE FRESHNESS, WIRED.
 *
 * The pure suite proves the rung; this proves the shell reaches it — and, in the
 * ordinary case, that the shell never trips it by accident. A live tick computes
 * its gate aggregate against the same instant it hands the controller, so the
 * rung is inert in production; a caller that supplies an aggregate it did not
 * just compute is exactly what the rung exists for.
 */
describe('a gate aggregate that is not a reading of the present', () => {
	it('holds the cell instead of stepping it up', async () => {
		const t = convexTest(schema, modules);
		// K_CLEAN already satisfied and no window anchor: with FRESH evidence this
		// tick would be an additive step, so the age is the only thing stopping it.
		await seed(t, { cleanStreak: 3 });
		const gateEvaluation = await import('../ramp/gateEvaluation');
		const spy = vi
			.spyOn(gateEvaluation.referenceArmGateEvaluator, 'evaluate')
			.mockImplementation((input) => cleanEvaluation(3, input.now - 400 * DAY_MS));

		try {
			await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		} finally {
			spy.mockRestore();
		}

		expect((await cellRow(t))?.ownShare).toBe(CELL_SHARE);
		const rows = await decisions(t);
		expect(rows[0]?.reason).toBe('evidence_stale');
		expect(rows[0]?.direction).toBe('hold');
	});

	it('is never what an ordinary tick decides — the shell dates its own evidence', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { cleanStreak: 3 });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const row = (await decisions(t))[0];
		expect(row?.reason).not.toBe('evidence_stale');
		const snapshot = JSON.parse(row?.snapshot ?? '{}') as {
			now?: number;
			evaluation?: { evaluatedAt?: number } | null;
		};
		expect(snapshot.evaluation?.evaluatedAt).toBe(snapshot.now);
	});
});

describe('the phase ladder', () => {
	it('promotes exactly one rung per call and cannot skip one', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const promote = async () =>
			await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, {
				stream: 'campaign' as const,
				destinationProvider: 'gmail' as const,
			});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			const cell = rows.find((row) => row.stream === 'campaign');
			if (cell) await ctx.db.patch(cell._id, { phaseCeiling: 0.25, mixVersion: 2 });
		});

		expect(await promote()).toEqual({ ok: true, phaseCeiling: 0.5 });
		expect(await promote()).toEqual({ ok: true, phaseCeiling: 0.8 });
		expect(await promote()).toEqual({ ok: true, phaseCeiling: 1 });
		// The top rung is the top rung: further promotions are no-ops.
		expect(await promote()).toEqual({ ok: true, phaseCeiling: 1 });

		// A promotion IS a new mix generation, so the salt advances once per real
		// rung — and not at all for the no-op at the top.
		expect((await cellRow(t))?.mixVersion).toBe(5);
	});

	it('is a no-op for a cell that has no ramp row', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, {
			stream: 'transactional' as const,
			destinationProvider: 'yahoo' as const,
		});
		expect(result).toEqual({ ok: false });
	});
});
