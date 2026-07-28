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
import { createTestInstanceSettings } from '../../__tests__/factories';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { modules } from './testModules';

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
const CELL_SHARE = 0.5;

type Harness = ReturnType<typeof convexTest>;
type Signal = {
	source:
		| 'dnsbl_listed'
		| 'dnsbl_partial'
		| 'ip_quarantined'
		| 'breaker_open'
		| 'persistent_defers';
	severity: 'warning' | 'critical';
	observedAt: number;
};

interface SeedOptions {
	/** Signals on the POOL row (`provider: 'all'`) — where the MTA files them. */
	readonly poolSignals?: readonly Signal[];
	/** Signals on the cell's own provider slice. */
	readonly providerSignals?: readonly Signal[];
	readonly abuseStatus?: 'clean' | 'suspended';
}

async function seed(t: Harness, options: SeedOptions = {}): Promise<void> {
	const now = Date.now();
	const base = {
		organizationId: ORG,
		isFallbackActive: false,
		snapshotGeneratedAt: now,
		expiresAt: now + DAY_MS,
		updatedAt: now,
	};
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({ abuseStatus: options.abuseStatus ?? 'clean' })
		);
		// The pool-wide slice the MTA writes its blocklist verdicts to.
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'all' as const,
			signals: [...(options.poolSignals ?? [])],
		});
		// The provider slice (stream-less: the snapshot's own row).
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'gmail' as const,
			signals: [...(options.providerSignals ?? [])],
		});
		// The MANAGED cell: the controller's own per-stream row.
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'gmail' as const,
			stream: 'campaign' as const,
			ownShare: CELL_SHARE,
			phaseCeiling: 1,
			cleanStreak: 3,
			mixVersion: 2,
			signals: [],
		});
	});
}

async function cellRow(t: Harness) {
	const rows = await t.run(
		async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
	);
	return rows.find((row) => row.stream === 'campaign');
}

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
