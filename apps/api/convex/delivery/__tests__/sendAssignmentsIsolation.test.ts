/**
 * Tenant isolation for the cell-keyed experiment record.
 *
 * `sendAssignments` is keyed by a cell (`campaign:gmail`) that is IDENTICAL
 * across tenants, so an index that is not org-leading would let one tenant
 * enumerate another's per-recipient send record. The plan's table sketch omits
 * `organizationId`; adding it (and making every caller-reachable index
 * org-leading) is a deliberate deviation, and this file is its guard.
 *
 * The join is asserted through `readAssignmentForSend` rather than through a
 * query shell: it IS the read every caller goes through, and a shell wrapping it
 * with no consumer is the speculative seam D20 forbids.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { createTestSendAssignment } from '../../__tests__/factories';
import { readAssignmentForSend } from '../sendAssignments';
import { TENANT_TABLES } from '../../lib/tenantTables';
import { ORGANIZATION_DELETION_STEPS, STEPS } from '../../workspaces/deletion/walker';

import { modules } from '../../__tests__/testModules';

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

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const CELL = 'campaign:gmail';

function assignment(organizationId: string, sendId: string, assignedAt: number) {
	return createTestSendAssignment({ organizationId, sendId, cell: CELL, assignedAt });
}

describe('sendAssignments tenant isolation', () => {
	it('cannot read another org assignment by send id', async () => {
		const t = convexTest(schema, modules);
		const now = 1_800_000_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('sendAssignments', assignment(ORG_B, 'send_b1', now));
		});

		await t.run(async (ctx) => {
			// Org A holding org B's send id gets nothing.
			expect(await readAssignmentForSend(ctx.db, ORG_A, 'send_b1')).toBeNull();
			// The owner does resolve it — the guard is scoping, not blanket denial.
			expect(await readAssignmentForSend(ctx.db, ORG_B, 'send_b1')).not.toBeNull();
		});
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
		// TWO, and the list is exhaustive on purpose: an index added here without
		// a reader is write amplification on a per-recipient table (D16/D20), and
		// a `by_org_cell_time` shipped and stayed unread for exactly that reason.
		expect(declared.map((index) => index.name).sort()).toEqual(['by_assigned_at', 'by_org_send']);
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

		await t.run(async (ctx) => {
			const a = await readAssignmentForSend(ctx.db, ORG_A, 'send_a1');
			expect(a?.organizationId).toBe(ORG_A);
			// The same cell, the same instant, the other tenant's send: still nothing.
			expect(await readAssignmentForSend(ctx.db, ORG_A, 'send_b1')).toBeNull();
			expect((await readAssignmentForSend(ctx.db, ORG_B, 'send_b1'))?.organizationId).toBe(ORG_B);
		});
	});
});
