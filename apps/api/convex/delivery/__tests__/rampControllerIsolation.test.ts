/**
 * ONE FAILING CELL DOES NOT STOP THE RAMP (plan D2, D13).
 *
 * A Convex mutation is one transaction: a throw rolls back everything it wrote,
 * INCLUDING the continuation it schedules for the next slice. So without
 * per-cell isolation, a single cell whose read hit a corrupt row would take down
 * every cell after it in the slice and every slice after that one — and the next
 * hourly tick would re-enter at cursor 0 and meet the same cell again. A cell
 * late in the grid could starve behind one early in it for as long as the fault
 * lasted, with nothing in the audit trail to say why.
 *
 * The failure is injected at `loadCellInput` because that is the widest per-cell
 * read in the tick and the one a corrupt row would actually reach. What the
 * suite pins is not the fault — it is the two properties around it: the cells
 * BEHIND the failure are still evaluated, and the failure is on the record.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { readManagedCell, seedRampCell, type Harness } from './rampCronFixtures';
import { MS_PER_DAY } from '../../lib/constants';

const ORG = 'org_ramp_isolation';

// The cell whose evaluation throws. `campaign/gmail` is the FIRST cell of the
// grid, so everything the tick would do afterwards is downstream of it.
const FAILING = { stream: 'campaign', destinationProvider: 'gmail' } as const;
const SURVIVOR = { stream: 'campaign', destinationProvider: 'yahoo' } as const;

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue(ORG),
	};
});

// The real read half, with ONE cell made to throw. Partial rather than wholesale:
// every other cell must go through the production reader, or the surviving cell
// would only prove that a stub can be called twice.
vi.mock('../rampControllerInputs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../rampControllerInputs')>();
	return {
		...actual,
		loadCellInput: vi.fn(async (ctx: never, args: { cell: typeof FAILING }) => {
			if (
				args.cell.stream === FAILING.stream &&
				args.cell.destinationProvider === FAILING.destinationProvider
			) {
				throw new Error('route state row is unreadable');
			}
			return await actual.loadCellInput(ctx, args as never);
		}),
	};
});

async function auditRows(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
}

async function decisionRows(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
}

/** A second managed cell, later in the grid than the one that throws. */
async function seedSurvivor(t: Harness): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: SURVIVOR.destinationProvider,
			stream: SURVIVOR.stream,
			isFallbackActive: false,
			ownShare: 0.5,
			phaseCeiling: 1,
			cleanStreak: 3,
			mixVersion: 2,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + MS_PER_DAY,
			updatedAt: now,
		});
	});
}

describe('a throwing cell does not starve the cells behind it', () => {
	it('evaluates the later cell and returns rather than aborting the slice', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		await seedSurvivor(t);

		const result = await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		// The tick completed and handed the grid on to the next slice — the
		// continuation a rolled-back transaction would have taken with it.
		expect(result.done).toBe(false);
		const decisions = await decisionRows(t);
		expect(decisions.map((row) => row.cell)).toEqual(['campaign:yahoo']);
	});

	it('leaves the surviving cell fully written, not half applied', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		await seedSurvivor(t);

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const survivor = await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			return rows.find((row) => row.destinationProvider === SURVIVOR.destinationProvider);
		});
		expect(survivor?.decidedAt).toBeGreaterThan(0);
	});

	// A CELL THE CONTROLLER SILENTLY STOPPED MEASURING IS THE WORST OUTCOME HERE,
	// so the failure is recorded under its own action rather than being swallowed
	// into the tick's ordinary decision log.
	it('records the failure against the cell that produced it', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const failures = (await auditRows(t)).filter(
			(row) => row.action === 'deliverability_ramp.cell_evaluation_failed'
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.resourceId).toBe('campaign:gmail');
		expect(failures[0]?.details?.['error']).toContain('unreadable');
		// And the cell it could not decide was not written on the way past: an
		// evaluation that threw reached no decision to apply.
		expect((await readManagedCell(t))?.decidedAt).toBeUndefined();
	});
});
