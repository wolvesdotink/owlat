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
 *   - a row with no stored share is not the ramp's to promote;
 *   - and the MACHINE entry (`rampControllerCron.promoteRampPhase`) answers the
 *     same rule. Both entries now share one implementation, so every arm the
 *     shell flattens — the refusals, the top rung, the outstanding evidence — is
 *     exercised through the shell too: a second entry that drifts is the exact
 *     failure that shape exists to prevent.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { readManagedCell, seedArmOutcomes, seedRampCell, type Harness } from './rampCronFixtures';

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

/**
 * A RUNG BOUNDS THE SHARE DIAL, SO IT BOUNDS ONLY A CELL THAT HAS ONE (plan D3).
 *
 * The controller re-reads that every tick (`phaseLadderBounds` drops both phase
 * bounds on a pace-actuated cell), and the operator's door has to read it the
 * same way: on a standalone deployment an enrolled cell sits at full share, and
 * the one enabled rung button would otherwise cut three quarters of its mail
 * toward a relay that does not exist — flipping the derived boolean, revoking a
 * graduation pin and spending a mix generation on a cohort with one arm in it.
 */
describe('a reset where the phase ladder does not bind', () => {
	it('takes the lower rung without touching a standalone cell’s share', async () => {
		const t = harness();
		const graduatedAt = Date.now() - 1_000;
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 1,
			phaseCeiling: 1,
			cleanStreak: 3,
			mixVersion: 2,
			graduatedAt,
		});

		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});

		// THE MOVE THE REVIEW ASKED FOR: one click must not land an enrolled
		// standalone cell at 25% of its own traffic.
		expect(result).toEqual({ applied: true, share: 1 });
		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(1);
		expect(row?.isFallbackActive).toBe(false);
		// No share moved, so no cohort is re-randomised and no pin is revoked.
		expect(row?.mixVersion).toBe(2);
		expect(row?.graduatedAt).toBe(graduatedAt);
		// The rung and the streak ARE the reset — both are stored state the cell
		// re-earns, and the rung binds again the tick a relay carries this cell.
		expect(row?.phaseCeiling).toBe(0.25);
		expect(row?.phaseCeilingSince).toBeGreaterThan(0);
		expect(row?.cleanStreak).toBe(0);

		const recorded = await decisions(t);
		expect(recorded).toHaveLength(1);
		// The timeline must not report a cut that did not happen.
		expect(recorded[0]?.fromShare).toBe(1);
		expect(recorded[0]?.toShare).toBe(1);
		expect(recorded[0]?.direction).toBe('hold');
		expect(recorded[0]?.message).toContain('no second sender');
		expect(await auditActions(t)).toContain('deliverability_ramp.phase_reset');
	});

	/**
	 * THE GRADUATION CLOCK IS AN EVIDENCE CLOCK, so a reset restarts it on the
	 * path where nothing else moves too. Holding it would let a standalone cell
	 * run out its fourteenth green day and PIN two days after an operator took it
	 * off its rung — a graduation awarded over the very stretch the reset declared
	 * untrusted, and the cheapest possible one to buy: on a standalone cell the
	 * reset costs no traffic at all.
	 *
	 * The pin ALREADY on the row is a different fact: it claims this cell's mail
	 * is carried by its own server, and that claim survives because the share did.
	 */
	it('restarts the graduation clock while holding the share and an existing pin', async () => {
		const t = harness();
		const graduatedAt = Date.now() - 1_000;
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 1,
			phaseCeiling: 1,
			greenSince: Date.now() - 13 * 24 * HOUR_MS,
			graduatedAt,
		});

		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.5,
		});

		expect(result).toEqual({ applied: true, share: 1 });
		const row = await readManagedCell(t);
		expect(row?.greenSince).toBeUndefined();
		expect(row?.ownShare).toBe(1);
		expect(row?.graduatedAt).toBe(graduatedAt);
	});

	it('cuts the same cell to the rung once a relay arm carries it', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 1,
			phaseCeiling: 1,
			mixVersion: 2,
			greenSince: Date.now() - 13 * 24 * HOUR_MS,
			graduatedAt: Date.now() - 1_000,
		});
		// The fold reads MEASUREMENT, not configuration: reference-arm outcome rows
		// for this cell inside the evaluation window are what "has a relay" means.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 40 });

		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});

		expect(result).toEqual({ applied: true, share: 0.25 });
		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(0.25);
		expect(row?.isFallbackActive).toBe(true);
		expect(row?.mixVersion).toBe(3);
		expect(row?.graduatedAt).toBeUndefined();
		// The clocks restart on this path for the same reason they do on the other.
		expect(row?.greenSince).toBeUndefined();
		expect((await decisions(t))[0]?.direction).toBe('decrease');
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
 * A STORED RUNG IS AN UNCONSTRAINED NUMBER in the schema, so both paths read it
 * through the ladder's own `normalizePhaseCeiling` rather than raw. Comparing a
 * normalised next rung against a RAW current one is how a degenerate row talks a
 * gate into a move nobody asked for.
 */
describe('a rung that is not on the ladder', () => {
	it('is at the top when it stands above it, and is not "promoted" downward', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 1, phaseCeiling: 1.2, mixVersion: 2 });

		const result = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		// Raw, this read `nextPhaseCeiling(1.2) === 1`, `1 !== 1.2`, "not at the
		// top" — and patched the ceiling DOWN to 1.0 while writing an audit row
		// claiming a promotion to 100% and spending a mix generation on it.
		expect(result).toEqual({ applied: false, phaseCeiling: 1 });
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(1.2);
		expect(row?.mixVersion).toBe(2);
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
	});

	it('is on the first rung when it stands below it, so a reset can still reach it', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, phaseCeiling: 0.1 });

		// Raw, `0.25 > 0.1` read as an upward move and refused: a cell stranded
		// below the ladder could never be put back on it by anyone.
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});
		expect(result.applied).toBe(true);
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});
});

/**
 * THE MACHINE ENTRY — a scheduler or another server-side flow, with no operator
 * to attribute the move to. It is a SHELL over `applyRampPhasePromotion`, and
 * the whole point of that shape is that it cannot answer differently from the
 * operator's door; every arm it flattens is pinned here through the shell.
 */
describe('the machine entry runs the same rule', () => {
	it('promotes one rung and stamps the dwell anchor, writing no operator audit', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			mixVersion: 2,
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, CELL);
		expect(result).toEqual({ ok: true, phaseCeiling: 0.5 });
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(0.5);
		expect(row?.mixVersion).toBe(3);
		// There is nobody to name, so this entry deliberately writes no D12 pair.
		expect(await auditActions(t)).toHaveLength(0);
		expect(await decisions(t)).toHaveLength(0);
	});

	/**
	 * A PER-STREAM ROW WITH NO STORED SHARE IS NOT THE RAMP'S. The old machine
	 * entry checked only that a row EXISTED, so it would happily patch a rung onto
	 * a cell the controller still skips — and the next enrolment would inherit it.
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
				mixVersion: 4,
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, CELL);
		expect(result).toEqual({ ok: false });
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBeUndefined();
		expect(row?.phaseCeilingSince).toBeUndefined();
		expect(row?.mixVersion).toBe(4);
	});

	/**
	 * THE HARD STOPS BOUND THIS ENTRY TOO, which they did not before: it checked
	 * the global kill switch and nothing else, so a cell inside a cooldown from an
	 * earlier retreat could be handed a rung by a scheduler.
	 */
	it('refuses inside a live cooldown from an earlier retreat', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			frozenUntil: Date.now() + HOUR_MS,
			freezeReason: 'gate_breach',
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, CELL);
		expect(result).toEqual({ ok: false });
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});

	it('reports the top rung as a success rather than a failure', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 1, phaseCeiling: 1, mixVersion: 2 });

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, CELL);
		// Nothing to promote is not a refusal: the caller asked for a state the
		// cell already has. The cohort is not re-randomised for a no-op.
		expect(result).toEqual({ ok: true, phaseCeiling: 1 });
		expect((await readManagedCell(t))?.mixVersion).toBe(2);
	});

	it('names the outstanding conditions when the evidence is short', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4, phaseCeiling: 0.5 });

		const result = await t.mutation(internal.delivery.rampControllerCron.promoteRampPhase, CELL);
		expect(result.ok).toBe(false);
		expect(result.phaseCeiling).toBe(0.5);
		expect(result.outstanding).toContain('dnsbl_clean_streak');
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.5);
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
