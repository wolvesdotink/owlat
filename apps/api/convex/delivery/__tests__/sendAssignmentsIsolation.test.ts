/**
 * Tenant isolation for the cell-keyed experiment record.
 *
 * `sendAssignments` is keyed by a cell (`campaign:gmail`) that is IDENTICAL
 * across tenants, so an index that is not org-leading would let one tenant
 * enumerate another's per-recipient send record. The plan's table sketch omits
 * `organizationId`; adding it (and making every index org-leading) is a
 * deliberate deviation, and this file is its guard.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { createTestSendAssignment } from '../../__tests__/factories';
import { TENANT_TABLES } from '../../lib/tenantTables';
import { ORGANIZATION_DELETION_STEPS, STEPS } from '../../workspaces/deletion/walker';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const CELL = 'campaign:gmail';
// A window wide enough to contain every fixture timestamp below. The read is
// a REQUIRED half-open [since, until) pair, so every caller states one.
const WINDOW = { since: 0, until: 2_000_000_000_000 };

function assignment(organizationId: string, sendId: string, assignedAt: number) {
	return createTestSendAssignment({ organizationId, sendId, cell: CELL, assignedAt });
}

describe('sendAssignments tenant isolation', () => {
	it('never returns another org rows from the cell/time index', async () => {
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a1', now));
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a2', now + 1));
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b1', now));
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b2', now + 1));
		});

		const aPage = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			...WINDOW,
		});
		expect(aPage.rows).toHaveLength(2);
		expect(aPage.hasMore).toBe(false);
		expect(aPage.rows.every((row) => row.organizationId === ORG_A)).toBe(true);
		expect(aPage.rows.map((row) => row.sendId).sort()).toEqual(['send_a1', 'send_a2']);

		const bPage = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_B,
			cell: CELL,
			...WINDOW,
		});
		expect(bPage.rows.map((row) => row.sendId).sort()).toEqual(['send_b1', 'send_b2']);
	});

	it('cannot read another org assignment by send id', async () => {
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b1', now));
		});

		// Org A holding org B's send id gets nothing.
		expect(
			await t.query(internal.delivery.sendAssignments.getAssignmentForSend, {
				organizationId: ORG_A,
				sendId: 'send_b1',
			})
		).toBeNull();
		// The owner does resolve it — the guard is scoping, not blanket denial.
		expect(
			await t.query(internal.delivery.sendAssignments.getAssignmentForSend, {
				organizationId: ORG_B,
				sendId: 'send_b1',
			})
		).not.toBeNull();
	});

	it('keeps the window filter inside the org partition', async () => {
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a_old', now - 10_000));
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a_new', now));
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b_new', now));
		});

		const page = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			since: now - 1_000,
			until: now + 1_000,
		});
		expect(page.rows.map((row) => row.sendId)).toEqual(['send_a_new']);
		expect(page.hasMore).toBe(false);
	});

	it('declares every caller-reachable index org-leading', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../../schema/sendAssignments.ts', import.meta.url), 'utf8')
		);
		const tableStart = source.indexOf('sendAssignments: defineTable(');
		expect(tableStart).toBeGreaterThanOrEqual(0);
		const table = source.slice(tableStart);
		// Anchor the end of the block on the NEXT table definition, not on a prose
		// comment: a reworded comment would silently widen the scanned block to the
		// rest of the file and make this guard pass vacuously.
		const nextTable = table.indexOf('defineTable(', 'sendAssignments: defineTable('.length);
		const indexBlock = nextTable === -1 ? table : table.slice(0, nextTable);
		const declared = [...indexBlock.matchAll(/\.index\('([^']+)',\s*\[([^\]]*)\]\)/g)].map(
			(match) => ({
				name: match[1] ?? '',
				fields: (match[2] ?? '')
					.split(',')
					.map((field) => field.trim().replace(/^'|'$/g, ''))
					.filter((field) => field.length > 0),
			})
		);
		expect(declared.map((index) => index.name).sort()).toEqual([
			'by_assigned_at',
			'by_org_cell_time',
			'by_org_send',
		]);
		// The ONE index that is not org-leading is exempt only because of where
		// it is used, and the module exports `cleanupExpiredAssignments`, so the
		// exemption is asserted rather than asserted-in-a-comment: `by_assigned_at`
		// must appear exactly once in the module, inside the retention sweep.
		// The day someone reaches for it from a caller-facing query, this fails.
		const moduleSource = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../sendAssignments.ts', import.meta.url), 'utf8')
		);
		const uses = [...moduleSource.matchAll(/withIndex\('by_assigned_at'/g)];
		expect(uses).toHaveLength(1);
		const sweepStart = moduleSource.indexOf('export const cleanupExpiredAssignments');
		expect(sweepStart).toBeGreaterThanOrEqual(0);
		expect(uses[0]?.index ?? -1).toBeGreaterThan(sweepStart);

		for (const index of declared) {
			// `by_assigned_at` serves the internal retention sweep only (pinned
			// just above). Every index a caller can reach with a cell or a send
			// id must start at the organization.
			if (index.name === 'by_assigned_at') {
				expect(index.fields).toEqual(['assignedAt']);
				continue;
			}
			expect(index.fields[0]).toBe('organizationId');
		}
	});

	it('returns nothing for a malformed cell key instead of scanning', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a1', 1_800_000_000_000));
		});

		for (const cell of ['campaign', 'campaign:', 'campaign:gmail:extra', 'newsletter:gmail', '']) {
			expect(
				await t.query(internal.delivery.sendAssignments.listCellAssignments, {
					organizationId: ORG_A,
					cell,
					...WINDOW,
				})
			).toEqual({ rows: [], hasMore: false });
		}
	});

	it('never unbounds the read on hostile numeric arguments', async () => {
		// Convex `v.number()` is a float64: NaN and Infinity are valid wire
		// values. An unguarded NaN reaches `.take(NaN)` and makes the range
		// bound meaningless, which on a per-recipient table (D16) is the exact
		// hazard the bounded read exists to prevent.
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			for (let index = 0; index < 5; index += 1) {
				await ctx.db.insert('sendAssignments', assignment(ORG_A, `send_${index}`, now + index));
			}
		});
		const read = async (overrides: { since?: number; until?: number; limit?: number }) =>
			await t.query(internal.delivery.sendAssignments.listCellAssignments, {
				organizationId: ORG_A,
				cell: CELL,
				...WINDOW,
				...overrides,
			});

		// A non-finite window bound cannot be honoured — return nothing.
		expect(await read({ since: Number.NaN })).toEqual({ rows: [], hasMore: false });
		expect(await read({ until: Number.NaN })).toEqual({ rows: [], hasMore: false });
		// A non-finite / out-of-range limit falls back to the bounded default.
		expect((await read({ limit: Number.NaN })).rows).toHaveLength(5);
		expect((await read({ limit: Number.POSITIVE_INFINITY })).rows).toHaveLength(5);
		expect((await read({ limit: 0 })).rows).toHaveLength(1);
		expect((await read({ limit: -10 })).rows).toHaveLength(1);
		expect((await read({ limit: 2.7 })).rows).toHaveLength(2);
		// …and a clamped limit still says so: 5 rows do not fit in 1.
		expect((await read({ limit: 0 })).hasMore).toBe(true);
	});

	it('reports truncation instead of silently returning the oldest page', async () => {
		// The index range is ASCENDING on `assignedAt`, so a window holding more
		// rows than the limit would hand back the OLDEST `limit` of them. A
		// consumer computing a rate over the window (the ramp controller's gates,
		// the dashboard) would inherit a truncated denominator that looks
		// complete — the "controller and dashboard disagree about a number"
		// hazard. `hasMore` makes the truncation impossible to miss.
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			for (let index = 0; index < 12; index += 1) {
				await ctx.db.insert('sendAssignments', assignment(ORG_A, `send_${index}`, now + index));
			}
			// Another tenant's rows in the SAME cell/window must not count toward
			// this org's truncation signal either.
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b', now));
		});

		const truncated = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			...WINDOW,
			limit: 5,
		});
		expect(truncated.rows).toHaveLength(5);
		expect(truncated.hasMore).toBe(true);
		expect(truncated.rows.map((row) => row.sendId)).toEqual([
			'send_0',
			'send_1',
			'send_2',
			'send_3',
			'send_4',
		]);

		// Exactly-full is NOT truncated: the extra probe row is what tells them
		// apart, so pin the boundary.
		const exact = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			...WINDOW,
			limit: 12,
		});
		expect(exact.rows).toHaveLength(12);
		expect(exact.hasMore).toBe(false);

		const orgB = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_B,
			cell: CELL,
			...WINDOW,
			limit: 5,
		});
		expect(orgB.rows).toHaveLength(1);
		expect(orgB.hasMore).toBe(false);
	});

	it('is wiped by the organization-deletion walker (GDPR scoping)', async () => {
		// The experiment record is per-recipient tenant business data. Account
		// deletion and 'Delete organization' must not leave it on disk, so the
		// table is registered in TENANT_TABLES and has a walker step.
		expect(TENANT_TABLES).toContain('sendAssignments');
		expect(STEPS).toContain('sendAssignments');
		expect(ORGANIZATION_DELETION_STEPS).toHaveProperty('sendAssignments');

		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a1', 1_800_000_000_000));
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b1', 1_800_000_000_000));
		});

		await t.mutation(internal.workspaces.deletion.walker.runStep, {
			table: 'sendAssignments',
		});
		// The walker chains follow-up hops; drain then cancel so no scheduled
		// job outlives the test.
		await t.finishInProgressScheduledFunctions();
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
				if (job.state.kind === 'pending' || job.state.kind === 'inProgress') {
					await ctx.scheduler.cancel(job._id);
				}
			}
		});

		// This deployment hosts one organization, so the wipe is total.
		const remaining = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(remaining).toHaveLength(0);
	});

	it('never mixes tenants when the same cell is written concurrently', async () => {
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await Promise.all([
			t.run(async (ctx) => {
				await ctx.db.insert('sendAssignments', assignment(ORG_A, 'send_a1', now));
			}),
			t.run(async (ctx) => {
				await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b1', now));
			}),
		]);

		const aPage = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			...WINDOW,
			limit: 500,
		});
		expect(aPage.rows).toHaveLength(1);
		expect(aPage.hasMore).toBe(false);
		expect(aPage.rows[0]?.organizationId).toBe(ORG_A);
	});
});
