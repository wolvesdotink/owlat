import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
	};
});

const modules = import.meta.glob('../**/*.*s');

/**
 * Guards the honest-pagination fix in transactional/sends.ts: the list queries
 * report a truthful `hasMore` boolean and no longer return a misleading `total`
 * (which was just an offset+limit+1 sentinel, not a count).
 */
describe('transactional/sends list pagination', () => {
	async function seed(t: ReturnType<typeof convexTest>, count: number) {
		return t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert('transactionalEmails', {
				name: 'TX',
				slug: 'tx',
				subject: 'Hi',
				content: '[]',
				status: 'published' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let i = 0; i < count; i++) {
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional' as const,
					transactionalEmailId,
					email: `r${i}@example.com`,
					status: 'sent' as const,
				});
			}
			return transactionalEmailId as Id<'transactionalEmails'>;
		});
	}

	it('listByTransactionalEmail returns hasMore and no total', async () => {
		const t = convexTest(schema, modules);
		const transactionalEmailId = await seed(t, 5);

		const page1 = await t.query(api.transactional.sends.listByTransactionalEmail, {
			transactionalEmailId,
			limit: 2,
			offset: 0,
		});
		expect(page1.sends).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		expect('total' in page1).toBe(false);

		const lastPage = await t.query(api.transactional.sends.listByTransactionalEmail, {
			transactionalEmailId,
			limit: 2,
			offset: 4,
		});
		expect(lastPage.sends).toHaveLength(1);
		expect(lastPage.hasMore).toBe(false);
	});

	it('listAll returns hasMore and no total', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 3);

		const page1 = await t.query(api.transactional.sends.listAll, {
			limit: 2,
			offset: 0,
		});
		expect(page1.sends).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		expect('total' in page1).toBe(false);

		const page2 = await t.query(api.transactional.sends.listAll, {
			limit: 2,
			offset: 2,
		});
		expect(page2.sends).toHaveLength(1);
		expect(page2.hasMore).toBe(false);
	});
});
