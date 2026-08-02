/**
 * A PHASE CEILING RISES ONE WAY ONLY (plan D3, D12).
 *
 * The rung is the biggest lever on the ramp: it bounds what the AIMD ladder may
 * climb to, and moving it re-shuffles which arm EVERY recipient of the cell
 * lands in. Plan D3 guards it with a table of evidence routes — an external
 * reading for the cell, or four corroborating self-hosted conditions — and a
 * gate that guards one of two doors is not a gate. So this suite pins the shape
 * rather than only the arithmetic:
 *
 *   - `resetCellPhase` moves a rung DOWN and refuses to move one up, naming the
 *     mutation that owns the upward move;
 *   - `promoteCellPhase` is that mutation, and it consults the routes;
 *   - every write that SETS a rung stamps `phaseCeilingSince`, because the dwell
 *     clock is one of the four standalone conditions and a rung with no anchor
 *     leaves a yahoo/apple/other cell unpromotable for ever;
 *   - a row with no stored share is not the ramp's to promote.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { readManagedCell, seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_phase_moves';
const HOUR_MS = 60 * 60 * 1000;

const session = vi.hoisted(() => ({ organizationId: 'org_ramp_phase_moves', isAdmin: true }));

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => session.organizationId),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireAdminContext: vi.fn(async () => {
			if (!session.isAdmin) throw new Error('Admin access required');
			return { userId: 'user_admin', role: 'owner' };
		}),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
	};
});

const CELL = { stream: 'campaign', destinationProvider: 'gmail' } as const;

function harness(): Harness {
	session.organizationId = ORG;
	session.isAdmin = true;
	return convexTest(schema, modules);
}

async function auditActions(t: Harness): Promise<string[]> {
	const rows = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
	return rows.map((row) => row.action);
}

async function decisions(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
}

describe('reset-to-phase is downward-only', () => {
	it('refuses to raise a ceiling and points at the promotion instead', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, phaseCeiling: 0.25 });

		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.5,
		});
		expect(result).toEqual({
			applied: false,
			refusal: 'phase_increase_requires_promotion',
		});
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(0.25);
		expect(row?.ownShare).toBe(0.2);
		// A refusal writes nothing — not even the audit pair a real move earns.
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
	});

	/**
	 * The absent ceiling is the interesting one: a row that predates the controller
	 * carries none, and a guard comparing the argument against itself would wave
	 * every raise through. The ladder's first rung is the reading the promotion
	 * path takes, and this asserts the reset path agrees with it.
	 */
	it('reads a ceiling-less row as sitting on the first rung', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, omitPhaseCeiling: true });

		const raised = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 1,
		});
		expect(raised.refusal).toBe('phase_increase_requires_promotion');
		expect((await readManagedCell(t))?.phaseCeiling).toBeUndefined();

		const onFirstRung = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});
		expect(onFirstRung.applied).toBe(true);
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});

	it('restarts the dwell clock on the rung it puts the cell back on', async () => {
		const t = harness();
		const staleAnchor = Date.now() - 40 * 24 * HOUR_MS;
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.8, phaseCeiling: 1 });
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			const cell = rows.find((row) => row.stream === 'campaign');
			if (cell !== undefined) await ctx.db.patch(cell._id, { phaseCeilingSince: staleAnchor });
		});

		await t.mutation(api.delivery.rampControls.resetCellPhase, { ...CELL, phaseCeiling: 0.25 });

		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(0.25);
		// Carrying the old anchor down would arrive on the low rung with that rung's
		// dwell already served, and the standalone route would hand the ceiling
		// straight back.
		expect(row?.phaseCeilingSince).toBeGreaterThan(staleAnchor);
	});
});

describe('promotion is the upward door', () => {
	it('raises one rung below the evidence line, stamps the dwell anchor and audits it', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			mixVersion: 2,
		});

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result).toEqual({ applied: true, phaseCeiling: 0.5 });

		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(0.5);
		expect(row?.phaseCeilingSince).toBeGreaterThan(0);
		// A promotion IS a new mix generation (plan D7).
		expect(row?.mixVersion).toBe(3);
		// IT MOVES THE CEILING, NOT THE SHARE: the share still has to earn each step.
		expect(row?.ownShare).toBe(0.2);

		expect(await auditActions(t)).toContain('deliverability_ramp.phase_promoted');
		const recorded = await decisions(t);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.reason).toBe('operator_phase_promotion');
		expect(recorded[0]?.fromShare).toBe(0.2);
		expect(recorded[0]?.toShare).toBe(0.2);
		expect(recorded[0]?.direction).toBe('hold');
	});

	it('refuses to cross the 0.5 line with no evidence, naming what is missing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4, phaseCeiling: 0.5 });

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('promotion_evidence_outstanding');
		expect(result.phaseCeiling).toBe(0.5);
		// Every applicable route's unmet conditions come back BY NAME so the screen
		// can say what would unlock the rung (plan D12/D14).
		expect(result.outstanding).toContain('google_compliance_pass');
		expect(result.outstanding).toContain('dnsbl_clean_streak');
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.5);
		// A refusal is not a decision: nothing lands in the timeline.
		expect(await decisions(t)).toHaveLength(0);
	});

	it('is a calm no-op at the top rung', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 1, phaseCeiling: 1, mixVersion: 2 });

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result).toEqual({ applied: false, phaseCeiling: 1 });
		// Re-randomising the cohort for a no-op would cost the comparison its
		// continuity for nothing.
		expect((await readManagedCell(t))?.mixVersion).toBe(2);
		expect(await auditActions(t)).toHaveLength(0);
	});

	/**
	 * A ROW WITH NO STORED SHARE IS NOT THE RAMP'S. Giving it a rung would leave a
	 * ceiling on a cell the controller still skips, and the next enrolment would
	 * inherit a rung nobody earned.
	 */
	it('refuses a per-stream row that carries no share, and patches nothing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result).toEqual({ applied: false, refusal: 'cell_not_ramp_managed' });
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBeUndefined();
		expect(row?.phaseCeilingSince).toBeUndefined();
	});

	it('refuses a cell this tenant does not have', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, phaseCeiling: 0.25 });

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, {
			stream: 'transactional' as const,
			destinationProvider: 'yahoo' as const,
		});
		expect(result).toEqual({ applied: false, refusal: 'cell_not_ramp_managed' });
	});
});

/**
 * A PROMOTION IS AN INCREASE, so it meets the increases' hard stops — through the
 * controller's own readers rather than a second copy of the rules.
 */
describe('hard stops bound a promotion', () => {
	it('refuses while the global kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			isPaused: true,
		});

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result).toEqual({ applied: false, refusal: 'controller_paused' });
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});

	it('refuses inside a live cooldown from an earlier retreat', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			frozenUntil: Date.now() + HOUR_MS,
			freezeReason: 'gate_breach',
		});

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(result).toEqual({ applied: false, refusal: 'hard_stop_active' });
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});
});

describe('the admin floor', () => {
	it('refuses a non-admin promotion and writes nothing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, phaseCeiling: 0.25 });
		session.isAdmin = false;
		try {
			await expect(
				t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL)
			).rejects.toThrow();
		} finally {
			session.isAdmin = true;
		}
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
		expect(await auditActions(t)).toHaveLength(0);
	});
});
