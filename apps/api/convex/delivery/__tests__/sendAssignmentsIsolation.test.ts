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
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

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

function assignment(organizationId: string, sendId: string, assignedAt: number) {
	return {
		organizationId,
		sendId,
		sendKind: 'campaign' as const,
		cell: CELL,
		transport: 'mta',
		arm: 'own' as const,
		calibration: false,
		mixVersion: 0,
		assignedAt,
	};
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

		const aRows = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
		});
		expect(aRows).toHaveLength(2);
		expect(aRows.every((row) => row.organizationId === ORG_A)).toBe(true);
		expect(aRows.map((row) => row.sendId).sort()).toEqual(['send_a1', 'send_a2']);

		const bRows = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_B,
			cell: CELL,
		});
		expect(bRows.map((row) => row.sendId).sort()).toEqual(['send_b1', 'send_b2']);
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

		const rows = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			since: now - 1_000,
			until: now + 1_000,
		});
		expect(rows.map((row) => row.sendId)).toEqual(['send_a_new']);
	});

	it('declares every caller-reachable index org-leading', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../../schema/delivery.ts', import.meta.url), 'utf8')
		);
		const table = source.slice(source.indexOf('sendAssignments: defineTable('));
		const indexBlock = table.slice(0, table.indexOf('// Provider Health'));
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
		for (const index of declared) {
			// `by_assigned_at` serves the internal retention sweep only and is
			// reachable from no exported function. Every index a caller can reach
			// with a cell or a send id must start at the organization.
			if (index.name === 'by_assigned_at') {
				expect(index.fields).toEqual(['assignedAt']);
				continue;
			}
			expect(index.fields[0]).toBe('organizationId');
		}
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

		const aRows = await t.query(internal.delivery.sendAssignments.listCellAssignments, {
			organizationId: ORG_A,
			cell: CELL,
			limit: 500,
		});
		expect(aRows).toHaveLength(1);
		expect(aRows[0]?.organizationId).toBe(ORG_A);
	});
});
