/**
 * THE OPERATOR CONTROLS, END TO END (plan D12, P3-6).
 *
 * Each control writes through an org-scoped, admin-gated mutation; each lands in
 * BOTH the audit log and the decision timeline; and none of them can reach
 * another tenant's row. The cross-tenant test is the one that matters most:
 * every mutation here takes a CELL from its arguments and its ORGANIZATION from
 * the session, so the only way to touch another tenant would be an index read
 * that was not org-leading.
 *
 * The named-test contract also covers the two things an operator must NOT be
 * able to do: force-advance without typing the consequence phrase, and reach a
 * phase rung the ladder has no name for.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { FORCE_ADVANCE_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import { modules } from '../../__tests__/testModules';
import { readManagedCell, seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_controls';
const OTHER_ORG = 'org_ramp_controls_other';

// `vi.hoisted`, not a bare const: `vi.mock` is hoisted above the imports, so a
// factory closing over an ordinary module-level binding would read it before it
// is initialised. The tenant has to be mutable — the cross-tenant test moves the
// SESSION while leaving the cell arguments alone.
const session = vi.hoisted(() => ({ organizationId: 'org_ramp_controls', isAdmin: true }));

// The mutations resolve their tenant through the shared singleton-org helper,
// which talks to the auth component; the harness has no component, so the suite
// mocks it exactly as the ramp cron suites do. `getMutationContext` and the
// admin floor are mocked for the same reason — the role gate itself is covered
// where it belongs, in the authedFunctions suites.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => session.organizationId),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		// THE ADMIN FLOOR IS REAL HERE, not merely stubbed away. `adminMutation`
		// calls this before the handler, so flipping `session.isAdmin` exercises the
		// gate the card's "org-scoped AUTHED mutation" claim rests on.
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

describe('pause', () => {
	it('holds the cell, records a decision and an audit entry', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4 });

		const result = await t.mutation(api.delivery.rampControls.setCellPause, {
			...CELL,
			isPaused: true,
		});
		expect(result.applied).toBe(true);

		const row = await readManagedCell(t);
		expect(row?.operatorPausedAt).toBeGreaterThan(0);
		// A pause does NOT move the share: it only stops it climbing.
		expect(row?.ownShare).toBe(0.4);

		expect(await auditActions(t)).toContain('deliverability_ramp.cell_paused');
		const recorded = await decisions(t);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.reason).toBe('operator_pause');
		expect(recorded[0]?.message).toContain('operator');
	});

	it('is idempotent — pausing a paused cell writes nothing new', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		await t.mutation(api.delivery.rampControls.setCellPause, { ...CELL, isPaused: true });
		const result = await t.mutation(api.delivery.rampControls.setCellPause, {
			...CELL,
			isPaused: true,
		});
		expect(result.applied).toBe(false);
		expect(await decisions(t)).toHaveLength(1);
	});

	it('clears on resume', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		await t.mutation(api.delivery.rampControls.setCellPause, { ...CELL, isPaused: true });
		await t.mutation(api.delivery.rampControls.setCellPause, { ...CELL, isPaused: false });
		expect((await readManagedCell(t))?.operatorPausedAt).toBeUndefined();
		expect(await auditActions(t)).toContain('deliverability_ramp.cell_resumed');
	});
});

describe('pin', () => {
	it('stores a clamped ceiling and audits it', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.5 });
		await t.mutation(api.delivery.rampControls.pinCellShare, { ...CELL, share: 1.7 });
		const row = await readManagedCell(t);
		expect(row?.operatorPinnedShare).toBe(1);
		// The pin never MOVES the share; it only bounds a future climb.
		expect(row?.ownShare).toBe(0.5);
		expect(await auditActions(t)).toContain('deliverability_ramp.cell_pinned');
	});

	it('removes the pin when asked for null', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		await t.mutation(api.delivery.rampControls.pinCellShare, { ...CELL, share: 0.3 });
		await t.mutation(api.delivery.rampControls.pinCellShare, { ...CELL, share: null });
		expect((await readManagedCell(t))?.operatorPinnedShare).toBeUndefined();
		expect(await auditActions(t)).toContain('deliverability_ramp.cell_unpinned');
	});

	it('refuses a share that is not a number', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		await expect(
			t.mutation(api.delivery.rampControls.pinCellShare, { ...CELL, share: Number.NaN })
		).rejects.toThrow();
	});
});

describe('force-advance', () => {
	it('refuses without the consequence-naming confirmation', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2 });
		await expect(
			t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
				...CELL,
				share: 0.9,
				confirmation: 'yes',
			})
		).rejects.toThrow();
		expect((await readManagedCell(t))?.ownShare).toBe(0.2);
		expect(await decisions(t)).toHaveLength(0);
	});

	it('moves the share with the confirmation, and never carries the streak across', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, cleanStreak: 3, mixVersion: 2 });
		await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.9,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(0.9);
		// The derived view stays consistent with the share (plan D1): at 0.9 the
		// relay still carries a tenth of the cell, so the fallback IS active.
		expect(row?.isFallbackActive).toBe(true);
		// Nothing about a manual move is earned.
		expect(row?.cleanStreak).toBe(0);
		expect(row?.greenSince).toBeUndefined();
		// A manual move is a new mix generation (plan D7).
		expect(row?.mixVersion).toBe(3);
		expect(await auditActions(t)).toContain('deliverability_ramp.force_advanced');
		const recorded = await decisions(t);
		expect(recorded[0]?.reason).toBe('operator_force_advance');
		expect(recorded[0]?.direction).toBe('increase');
	});
});

describe('reset to a phase', () => {
	it('accepts only a rung on the ladder', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		await expect(
			t.mutation(api.delivery.rampControls.resetCellPhase, { ...CELL, phaseCeiling: 0.42 })
		).rejects.toThrow();
	});

	it('brings the share back under the new ceiling and restarts the streak', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.8, cleanStreak: 3 });
		await t.mutation(api.delivery.rampControls.resetCellPhase, { ...CELL, phaseCeiling: 0.25 });
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBe(0.25);
		expect(row?.ownShare).toBe(0.25);
		expect(row?.cleanStreak).toBe(0);
		expect(await auditActions(t)).toContain('deliverability_ramp.phase_reset');
	});
});

/**
 * A HAND ON THE CONTROL IS STILL A HAND INSIDE THE HARD STOPS.
 *
 * `promoteRampPhase` already refuses under the global kill switch; the operator
 * mutations that write a share directly must refuse under the same conditions,
 * or every hard stop becomes optional in exactly the situation it exists for.
 * Downward moves stay allowed throughout — a retreat is never blocked.
 */
describe('hard stops bound the operator, not only the controller', () => {
	it('refuses a force-advance UP while the global kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, isPaused: true });
		const result = await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.9,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('controller_paused');
		expect((await readManagedCell(t))?.ownShare).toBe(0.2);
		expect(await decisions(t)).toHaveLength(0);
	});

	it('still lets an operator move a cell DOWN while the kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.8, isPaused: true });
		const result = await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.1,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		expect(result.applied).toBe(true);
		expect((await readManagedCell(t))?.ownShare).toBe(0.1);
	});

	it('refuses a force-advance UP while sending is abuse-suspended', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.2, abuseStatus: 'suspended' });
		const result = await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.9,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('hard_stop_active');
		expect((await readManagedCell(t))?.ownShare).toBe(0.2);
	});

	it('refuses a force-advance UP inside a live cooldown', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			frozenUntil: Date.now() + 60 * 60 * 1000,
			freezeReason: 'gate_breach',
		});
		const result = await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.9,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('hard_stop_active');
	});

	it('refuses raising a PHASE ceiling while the kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			phaseCeiling: 0.25,
			isPaused: true,
		});
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 1,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('controller_paused');
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});

	/**
	 * THE ABSENT CEILING IS THE INTERESTING ONE. `phaseCeiling` is optional, so a
	 * row that predates the controller carries none — and a guard that falls back
	 * to the ARGUMENT would compare a value against itself and wave every raise
	 * through. The ladder's first rung is the reading `promoteRampPhase` takes,
	 * and this asserts the operator path agrees with it.
	 */
	it('refuses raising the ceiling of a row with NO stored ceiling under the kill switch', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			omitPhaseCeiling: true,
			isPaused: true,
		});
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 1,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('controller_paused');
		const row = await readManagedCell(t);
		expect(row?.phaseCeiling).toBeUndefined();
		expect(row?.ownShare).toBe(0.2);
		expect(await decisions(t)).toHaveLength(0);
	});

	it('refuses raising the ceiling of a ceiling-less row inside a live cooldown', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			omitPhaseCeiling: true,
			frozenUntil: Date.now() + 60 * 60 * 1000,
			freezeReason: 'gate_breach',
		});
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 1,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('hard_stop_active');
		expect((await readManagedCell(t))?.phaseCeiling).toBeUndefined();
	});

	it('still lets a ceiling-less row be put on the FIRST rung under the kill switch', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 0.2,
			omitPhaseCeiling: true,
			isPaused: true,
		});
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});
		expect(result.applied).toBe(true);
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});

	it('still lets a phase be reset DOWNWARD while the kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.8, phaseCeiling: 1, isPaused: true });
		const result = await t.mutation(api.delivery.rampControls.resetCellPhase, {
			...CELL,
			phaseCeiling: 0.25,
		});
		expect(result.applied).toBe(true);
		expect((await readManagedCell(t))?.phaseCeiling).toBe(0.25);
	});
});

describe('a hand-moved cell does not keep its graduation pin', () => {
	it('revokes it on a force-advance below full share', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 1,
			graduatedAt: Date.now() - 1_000,
		});
		await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 0.25,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		// Otherwise the Cells grid still reads "Graduated" and the relay-removal
		// projection still counts the cell as no longer leaning on the relay,
		// while three quarters of its mail is back on it.
		expect((await readManagedCell(t))?.graduatedAt).toBeUndefined();
		const recorded = await decisions(t);
		expect(recorded[0]?.snapshot).toContain('revoked');
	});

	it('revokes it on a phase reset below full share', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			ownShare: 1,
			phaseCeiling: 1,
			graduatedAt: Date.now() - 1_000,
		});
		await t.mutation(api.delivery.rampControls.resetCellPhase, { ...CELL, phaseCeiling: 0.5 });
		expect((await readManagedCell(t))?.graduatedAt).toBeUndefined();
	});

	it('keeps it when the move lands at full share', async () => {
		const graduatedAt = Date.now() - 1_000;
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 1, graduatedAt });
		await t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
			...CELL,
			share: 1,
			confirmation: FORCE_ADVANCE_CONFIRMATION,
		});
		expect((await readManagedCell(t))?.graduatedAt).toBe(graduatedAt);
	});
});

describe('presets', () => {
	it('stores, updates and clears a per-stream choice, auditing each time', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });

		await t.mutation(api.delivery.rampControls.setStreamPreset, {
			stream: 'campaign',
			preset: 'aggressive',
		});
		let rows = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.preset).toBe('aggressive');

		await t.mutation(api.delivery.rampControls.setStreamPreset, {
			stream: 'campaign',
			preset: 'conservative',
		});
		rows = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.preset).toBe('conservative');

		// Clearing returns the stream to the DEPLOYMENT DEFAULT rather than to a
		// stored 'balanced', so a later relay changes the pace automatically.
		await t.mutation(api.delivery.rampControls.setStreamPreset, {
			stream: 'campaign',
			preset: null,
		});
		rows = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(rows).toHaveLength(0);
		expect(
			(await auditActions(t)).filter((action) => action === 'deliverability_ramp.preset_changed')
		).toHaveLength(3);
	});
});

describe('cross-tenant', () => {
	it('never touches another organization’s cell, and refuses calmly', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4 });

		// The caller's session now resolves to a DIFFERENT organization. The cell
		// arguments are unchanged: only the tenant moved.
		session.organizationId = OTHER_ORG;
		const result = await t.mutation(api.delivery.rampControls.setCellPause, {
			...CELL,
			isPaused: true,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('cell_not_ramp_managed');

		session.organizationId = ORG;
		const row = await readManagedCell(t);
		expect(row?.operatorPausedAt).toBeUndefined();
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
	});

	it('files a preset against the caller’s own organization only', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		session.organizationId = OTHER_ORG;
		await t.mutation(api.delivery.rampControls.setStreamPreset, {
			stream: 'campaign',
			preset: 'aggressive',
		});
		const rows = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.organizationId).toBe(OTHER_ORG);
	});
});

describe('the admin floor', () => {
	it('refuses a non-admin caller and writes nothing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4 });
		session.isAdmin = false;
		try {
			await expect(
				t.mutation(api.delivery.rampControls.setCellPause, { ...CELL, isPaused: true })
			).rejects.toThrow();
			await expect(
				t.mutation(api.delivery.rampControls.forceAdvanceCellShare, {
					...CELL,
					share: 0.9,
					confirmation: FORCE_ADVANCE_CONFIRMATION,
				})
			).rejects.toThrow();
			await expect(
				t.mutation(api.delivery.rampControls.setStreamPreset, {
					stream: 'campaign',
					preset: 'aggressive',
				})
			).rejects.toThrow();
		} finally {
			session.isAdmin = true;
		}
		const row = await readManagedCell(t);
		expect(row?.operatorPausedAt).toBeUndefined();
		expect(row?.ownShare).toBe(0.4);
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
		const presets = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(presets).toHaveLength(0);
	});
});

describe('an unmanaged cell', () => {
	it('is refused without being created', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG });
		const result = await t.mutation(api.delivery.rampControls.setCellPause, {
			stream: 'transactional',
			destinationProvider: 'yahoo',
			isPaused: true,
		});
		expect(result.applied).toBe(false);
		expect(result.refusal).toBe('cell_not_ramp_managed');
		const rows = await t.run(
			async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
		);
		expect(rows.some((row) => row.destinationProvider === 'yahoo')).toBe(false);
	});
});
