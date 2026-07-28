/**
 * THE GLOBAL KILL SWITCH — the plan's named mitigation for controller
 * complexity, shipped with the controller rather than after it.
 *
 * The contract: one flag pins EVERY cell at its current share, honoured before
 * any other logic including the hard stops. A paused controller still evaluates
 * and still audits — so an operator can watch what it would have done — and
 * writes no share.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { allDeliverabilityCells } from '@owlat/shared/deliverabilityRouting';
import { createTestInstanceSettings } from '../../__tests__/factories';
import { nextShare } from '../ramp/controller';
import { RAMP_STREAM_CONFIGS } from '../ramp/gateConfig';
import {
	cleanEvaluation,
	controllerInput,
	mixState,
	NOW,
} from '../ramp/__tests__/controllerFixtures';
import { modules } from './testModules';

// The cron resolves its tenant through the shared singleton-org helper, which
// talks to the auth component; the harness has no component, so the suite mocks
// it exactly as the transportOutcomes suites do.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_kill_switch'),
		// The OPERATOR path to the switch is `workspaces/settings.update`, which is
		// gated on `settings:manage`. The harness has no session, so the permission
		// check is satisfied as an owner — the gate itself is covered where it
		// belongs, in workspaces/__tests__/settings.test.ts.
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const ORG = 'org_ramp_kill_switch';
const DAY_MS = 24 * 60 * 60 * 1000;

type Harness = ReturnType<typeof convexTest>;

async function seed(t: Harness, options: { isPaused: boolean }): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: 'clean' as const,
				isRampControllerPaused: options.isPaused,
			})
		);
		// The stream-less row the MTA snapshot owns, plus one MANAGED cell.
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail' as const,
			isFallbackActive: false,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + DAY_MS,
			updatedAt: now,
		});
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail' as const,
			stream: 'campaign' as const,
			isFallbackActive: true,
			ownShare: 0.1,
			phaseCeiling: 1,
			cleanStreak: 9,
			mixVersion: 3,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + DAY_MS,
			updatedAt: now,
		});
	});
}

async function managedRow(t: Harness) {
	// A whole-table read rather than an index scan: the harness ctx is untyped
	// for named indexes, and the table holds two rows in this fixture.
	const rows = await t.run(
		async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
	);
	return rows.find((row) => row.stream === 'campaign');
}

describe('the kill switch, in the decision function', () => {
	it('pins every cell of the grid before any other logic', () => {
		for (const cell of allDeliverabilityCells()) {
			const decision = nextShare(
				controllerInput({
					cell,
					config: RAMP_STREAM_CONFIGS[cell.stream],
					isKillSwitchEngaged: true,
					mix: mixState({ share: 0.37, cleanStreak: 99, greenSince: NOW - 40 * DAY_MS }),
					evaluation: cleanEvaluation(99),
					// Every hard stop active at once, and a capacity projection begging
					// for an increase. The switch still wins.
					signals: {
						isSendingAllowed: false,
						isCircuitBreakerOpen: true,
						isPoolBlocklisted: true,
					},
					capacity: { kind: 'projected', warmingCapRemaining: 1e9, projectedVolume: 1 },
				})
			);
			expect(decision.share).toBe(0.37);
			expect(decision.reason).toBe('kill_switch');
			expect(decision.direction).toBe('hold');
			expect(decision.frozenUntil).toBeUndefined();
			expect(decision.cooldownMs).toBeUndefined();
		}
	});
});

describe('the kill switch, through the cron', () => {
	it('writes no share while paused, but still audits every evaluation', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: true });
		const before = await managedRow(t);

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const after = await managedRow(t);
		expect(after?.ownShare).toBe(before?.ownShare);
		expect(after?.cleanStreak).toBe(before?.cleanStreak);
		expect(after?.mixVersion).toBe(before?.mixVersion);
		expect(after?.phaseCeiling).toBe(before?.phaseCeiling);
		// The LEASE is the one thing a paused tick does write: see the TTL case
		// below for why "pinned" has to outlive the route-state cache horizon.
		expect(after?.expiresAt ?? 0).toBeGreaterThanOrEqual(before?.expiresAt ?? 0);

		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.reason).toBe('kill_switch');
		expect(decisions[0]?.direction).toBe('hold');
		expect(decisions[0]?.message).toContain('kill switch');

		// A paused controller changes nothing, so it logs nothing to the audit log.
		const auditLogs = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(auditLogs).toHaveLength(0);
	});

	it('evaluates and writes again once the switch is released', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const after = await managedRow(t);
		// With no outcome data every gate holds, so the share does not move — but
		// the row IS refreshed, which is how "the controller ran" is observable.
		expect(after?.ownShare).toBe(0.1);
		expect(after?.isFallbackActive).toBe(true);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.reason).toBe('holding');
	});

	it('leaves an UNMANAGED cell alone entirely — no row, no share, no audit', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const rows = await t.run(
			async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
		);
		// Still exactly the two seeded rows: the controller never seeds a cell.
		expect(rows).toHaveLength(2);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions.map((row) => row.cell)).toEqual(['campaign:gmail']);
	});

	it('is a no-op on a deployment with no routing state at all', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', createTestInstanceSettings({}));
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		expect(result.evaluated).toBe(0);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(0);
	});

	// THE PAUSE MUST OUTLIVE THE CACHE. Route-state rows carry a 24h TTL and the
	// shipped 5-minute sweep deletes anything past it. A paused cell whose lease
	// stopped being renewed would be DELETED, and a missing row resolves to share
	// 1.0 — every recipient onto the own MTA, the exact opposite of "pinned".
	it('survives the route-state TTL sweep while paused, with its share intact', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const start = Date.UTC(2026, 6, 1, 0, 0, 0);
			vi.setSystemTime(start);
			const t = convexTest(schema, modules);
			await seed(t, { isPaused: true });

			// Two paused ticks, 23h apart: each one renews the lease and writes no
			// share. Then the sweep runs a day and a bit after the FIRST tick.
			await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
			vi.setSystemTime(start + 23 * 60 * 60 * 1000);
			await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
			vi.setSystemTime(start + 25 * 60 * 60 * 1000);
			await t.mutation(internal.delivery.deliverabilityRouting.cleanupExpired, {});

			const row = await managedRow(t);
			expect(row).toBeDefined();
			expect(row?.ownShare).toBe(0.1);
			expect(row?.cleanStreak).toBe(9);
			expect(row?.mixVersion).toBe(3);
			expect(row?.phaseCeiling).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('would lose that state if the lease were not renewed — the sweep is real', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const start = Date.UTC(2026, 6, 1, 0, 0, 0);
			vi.setSystemTime(start);
			const t = convexTest(schema, modules);
			await seed(t, { isPaused: true });

			// No tick at all for a day: the control for the case above.
			vi.setSystemTime(start + 25 * 60 * 60 * 1000);
			await t.mutation(internal.delivery.deliverabilityRouting.cleanupExpired, {});
			expect(await managedRow(t)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	// THE OPERATOR PATH, not a test-only seam: the switch is engaged through the
	// same permission-gated, audited settings mutation an admin uses from the
	// product, and the very next controller tick honours it.
	it('is engaged through the operator settings path and honoured on the next tick', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });

		await t.mutation(api.workspaces.settings.update, { isRampControllerPaused: true });
		const settings = await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
		expect(settings?.isRampControllerPaused).toBe(true);

		const before = await managedRow(t);
		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		const after = await managedRow(t);
		expect(after?.ownShare).toBe(before?.ownShare);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions[0]?.reason).toBe('kill_switch');
	});

	// A PROMOTION IS A MOVE. It raises the phase ceiling AND bumps `mixVersion`,
	// which re-shuffles which arm every recipient of the cell lands in (plan D7) —
	// the last thing anyone wants mid-incident, while the controller is
	// deliberately frozen. "Everything held still" has to mean everything.
	it('refuses a phase promotion while the switch is engaged', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: true });
		// Off the top rung, so an honoured promotion would demonstrably move both
		// the ceiling and the mix generation.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			const cell = rows.find((row) => row.stream === 'campaign');
			if (cell) await ctx.db.patch(cell._id, { phaseCeiling: 0.25 });
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, {
			stream: 'campaign' as const,
			destinationProvider: 'gmail' as const,
		});

		expect(result).toEqual({ ok: false });
		const row = await managedRow(t);
		expect(row?.phaseCeiling).toBe(0.25);
		expect(row?.mixVersion).toBe(3);
	});
});
