/**
 * `countBlockedByReason` is the one per-reason counter over `blockedEmails`.
 * The operator suppression screen and the platform-admin org detail used to
 * hand-list the reasons each, so a new reason would have been stored and then
 * silently left out of both totals. These pin that every `BLOCK_REASONS` entry
 * is counted, that the total is their sum, and that each class saturates at
 * the view cap instead of reading the whole table.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { BLOCKLIST_VIEW_LIMIT, countBlockedByReason } from '../blockedEmails/lookup';
import { BLOCK_REASONS, type BlockReason } from '../lib/literalValidators';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');
const identity = { subject: 'test-user', tokenIdentifier: 'test|test-user' };

async function seed(t: ReturnType<typeof convexTest>, reason: BlockReason, count: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('blockedEmails', {
				email: `${reason}-${i}@example.com`,
				reason,
				createdAt: Date.now(),
			});
		}
	});
}

describe('countBlockedByReason', () => {
	it('counts every BLOCK_REASONS entry and sums them into total', async () => {
		const t = convexTest(schema, modules);
		const seeded = { bounced: 3, complained: 1, manual: 2, unengaged: 4 } satisfies Record<
			BlockReason,
			number
		>;
		for (const reason of BLOCK_REASONS) await seed(t, reason, seeded[reason]);

		const counts = await t.run(async (ctx) => await countBlockedByReason(ctx));
		expect(counts).toEqual({ total: 10, ...seeded });
		expect(Object.keys(counts).sort()).toEqual(['total', ...BLOCK_REASONS].sort());
	});

	it('reports zero for a reason with no rows', async () => {
		const t = convexTest(schema, modules);
		const counts = await t.run(async (ctx) => await countBlockedByReason(ctx));
		expect(counts).toEqual({ total: 0, bounced: 0, complained: 0, manual: 0, unengaged: 0 });
	});

	it('saturates one class at the view cap', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 'bounced', BLOCKLIST_VIEW_LIMIT + 1);
		await seed(t, 'manual', 1);

		const counts = await t.run(async (ctx) => await countBlockedByReason(ctx));
		expect(counts.bounced).toBe(BLOCKLIST_VIEW_LIMIT);
		expect(counts.total).toBe(BLOCKLIST_VIEW_LIMIT + 1);
	});

	it('is what blockedEmails.getCountsByReason returns', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 'complained', 2);
		await seed(t, 'unengaged', 1);

		const viaQuery = await t.withIdentity(identity).query(api.blockedEmails.getCountsByReason, {});
		const direct = await t.run(async (ctx) => await countBlockedByReason(ctx));
		expect(viaQuery).toEqual(direct);
	});
});
