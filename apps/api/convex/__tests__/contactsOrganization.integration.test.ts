import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

// ============ listAllIdsByOrganization ============

describe('contactsOrganization.listAllIdsByOrganization', () => {
	it('should return all contact IDs', async () => {
		const t = convexTest(schema, modules);
		let id1: Id<'contacts'>;
		let id2: Id<'contacts'>;

		await t.run(async (ctx) => {
			id1 = await ctx.db.insert('contacts', createTestContact({
				email: 'ids1@example.com',
			}));
			id2 = await ctx.db.insert('contacts', createTestContact({
				email: 'ids2@example.com',
			}));
		});

		const result = await t.query(api.contacts.organization.listAllIdsByOrganization, {});

		expect(result.ids).toHaveLength(2);
		expect(result.ids).toContain(id1!);
		expect(result.ids).toContain(id2!);
		expect(result.truncated).toBe(false);
	});

	// Search tests use withSearchIndex which is not supported in convexTest.
	// Search functionality is tested against the real Convex backend.
	it.skip('should filter by search term on email (requires search index)', async () => {
		// Uses withSearchIndex('search_contacts', ...) — not available in test framework
	});

	it.skip('should filter by search term on firstName (requires search index)', async () => {
		// Uses withSearchIndex('search_contacts', ...) — not available in test framework
	});

	it.skip('should filter by search term on lastName (requires search index)', async () => {
		// Uses withSearchIndex('search_contacts', ...) — not available in test framework
	});
});
