/**
 * Curated answers (`isAuthoritative`) outrank every extracted fact and are
 * quoted to customers, so only owners and admins may write them. Members keep
 * editing and deleting the rest of the knowledge graph.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestKnowledgeEntry } from './factories';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';

const sessionMock = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'member' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: 'test-user',
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockImplementation(async () => session()),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			actual.requirePermission(
				actual.hasPermission(sessionMock.role, 'organization:manage'),
				'Only owners and admins can perform this action'
			);
			return session();
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

async function seedEntry(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown>
): Promise<Id<'knowledgeEntries'>> {
	return t.run((ctx) => ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry(overrides)));
}

describe('curated knowledge answers are admin-only', () => {
	beforeEach(() => {
		sessionMock.role = 'owner';
	});

	it('lets an admin author a curated answer', async () => {
		const t = convexTest(schema, modules);
		sessionMock.role = 'admin';
		const id = await t.mutation(api.knowledge.graph.createPolicyEntry, {
			title: 'Refund window?',
			content: '30 days.',
		});
		const entry = await t.run((ctx) => ctx.db.get(id!));
		expect(entry?.isAuthoritative).toBe(true);
	});

	it('refuses a member authoring or rewriting a curated answer', async () => {
		const t = convexTest(schema, modules);
		const extracted = await seedEntry(t, {});
		sessionMock.role = 'member';

		await expect(
			t.mutation(api.knowledge.graph.createPolicyEntry, {
				title: 'Refund window?',
				content: 'Forever.',
			})
		).rejects.toThrow();
		await expect(
			t.mutation(api.knowledge.graph.createPolicyEntry, {
				entryId: extracted,
				title: 'Refund window?',
				content: 'Forever.',
			})
		).rejects.toThrow();

		const entry = await t.run((ctx) => ctx.db.get(extracted));
		expect(entry?.isAuthoritative).toBeUndefined();
	});

	it('refuses a member editing or deleting a curated answer', async () => {
		const t = convexTest(schema, modules);
		const curated = await seedEntry(t, {
			sourceType: 'curated',
			isAuthoritative: true,
			entryType: 'faq',
			content: '30 days.',
		});
		sessionMock.role = 'member';

		await expect(
			t.mutation(api.knowledge.graph.updateEntry, { entryId: curated, content: 'Forever.' })
		).rejects.toThrow(/curated answer/);
		await expect(t.mutation(api.knowledge.graph.deleteEntry, { entryId: curated })).rejects.toThrow(
			/curated answer/
		);

		const entry = await t.run((ctx) => ctx.db.get(curated));
		expect(entry?.content).toBe('30 days.');
	});

	it('still lets a member correct an extracted fact', async () => {
		const t = convexTest(schema, modules);
		const extracted = await seedEntry(t, { content: 'old' });
		sessionMock.role = 'member';

		await t.mutation(api.knowledge.graph.updateEntry, { entryId: extracted, content: 'new' });
		const entry = await t.run((ctx) => ctx.db.get(extracted));
		expect(entry?.content).toBe('new');
	});
});
