import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestContact, createTestInstanceSettings } from './factories';
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
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const modules = import.meta.glob('../**/*.*s');

// ============ contacts.create ============

describe('contacts.create', () => {
	it('should create a contact with correct fields', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.mutation(api.contacts.contacts.create, {
			email: 'test@example.com',
			firstName: 'Test',
			lastName: 'User',
		});

		expect(contactId).toBeDefined();

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact).toBeDefined();
			expect(contact!.email).toBe('test@example.com');
			expect(contact!.firstName).toBe('Test');
			expect(contact!.lastName).toBe('User');
			expect(contact!.source).toBe('api');
			expect(contact!.searchableText).toContain('test@example.com');
			expect(contact!.searchableText).toContain('test');
			expect(contact!.searchableText).toContain('user');
			expect(contact!.createdAt).toBeTypeOf('number');
			expect(contact!.updatedAt).toBeTypeOf('number');
		});
	});

	it('should normalize email to lowercase', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.mutation(api.contacts.contacts.create, {
			email: 'UPPER@EXAMPLE.COM',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact!.email).toBe('upper@example.com');
		});
	});

	it('should trim whitespace from email', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.mutation(api.contacts.contacts.create, {
			email: '  spaced@example.com  ',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact!.email).toBe('spaced@example.com');
		});
	});

	it('should create a contact with only email (optional fields omitted)', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.mutation(api.contacts.contacts.create, {
			email: 'minimal@example.com',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact).toBeDefined();
			expect(contact!.email).toBe('minimal@example.com');
			expect(contact!.firstName).toBeUndefined();
			expect(contact!.lastName).toBeUndefined();
		});
	});

	it('should throw on duplicate email', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.contacts.contacts.create, {
			email: 'duplicate@example.com',
			firstName: 'First',
		});

		await expect(
			t.mutation(api.contacts.contacts.create, {
				email: 'duplicate@example.com',
				firstName: 'Second',
			})
		).rejects.toThrow(/already exists/);
	});

	it('should treat same email with different case as duplicate', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.contacts.contacts.create, {
			email: 'case@example.com',
		});

		await expect(
			t.mutation(api.contacts.contacts.create, {
				email: 'CASE@EXAMPLE.COM',
			})
		).rejects.toThrow(/already exists/);
	});

	it('should accept a custom source', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.mutation(api.contacts.contacts.create, {
			email: 'form@example.com',
			source: 'form',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact!.source).toBe('form');
		});
	});
});

// ============ contacts.update ============

describe('contacts.update', () => {
	it('should update firstName and lastName', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'update@example.com',
				firstName: 'Old',
				lastName: 'Name',
			}));
		});

		await t.mutation(api.contacts.contacts.update, {
			contactId: contactId!,
			firstName: 'New',
			lastName: 'Updated',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.firstName).toBe('New');
			expect(contact!.lastName).toBe('Updated');
			expect(contact!.updatedAt).toBeTypeOf('number');
		});
	});

	it('should update email and check for duplicates', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'original@example.com',
			}));
		});

		await t.mutation(api.contacts.contacts.update, {
			contactId: contactId!,
			email: 'newemail@example.com',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.email).toBe('newemail@example.com');
		});
	});

	it('should throw when updating email to one that already exists', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({
				email: 'existing@example.com',
			}));
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'willchange@example.com',
			}));
		});

		await expect(
			t.mutation(api.contacts.contacts.update, {
				contactId: contactId!,
				email: 'existing@example.com',
			})
		).rejects.toThrow(/already exists/);
	});

	it('should update searchableText when name changes', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'search@example.com',
				firstName: 'Old',
				lastName: 'Name',
			}));
		});

		await t.mutation(api.contacts.contacts.update, {
			contactId: contactId!,
			firstName: 'New',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.searchableText).toContain('new');
		});
	});

	it('should update timezone and language', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'tz@example.com',
			}));
		});

		await t.mutation(api.contacts.contacts.update, {
			contactId: contactId!,
			timezone: 'Europe/Berlin',
			language: 'de',
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.timezone).toBe('Europe/Berlin');
			expect(contact!.language).toBe('de');
		});
	});
});

// ============ contacts.remove ============

describe('contacts.remove', () => {
	it('should delete a contact', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'todelete@example.com',
			}));
		});

		await t.mutation(api.contacts.contacts.remove, {
			contactId: contactId!,
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			// Soft-delete: row is still present but marked as deleted.
			expect(contact).not.toBeNull();
			expect(contact?.deletedAt).toBeDefined();
		});
	});

	it('should delete related contact-topic memberships', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'withrelations@example.com',
			}));
			const topicId = await ctx.db.insert('topics', {
	
				name: 'Test Topic',
				createdAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(api.contacts.contacts.remove, {
			contactId: contactId!,
		});

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			// Soft-delete: contact row persists with deletedAt set, but cascade to
			// children is deferred until the cleanup cron runs after the 30-day
			// retention window. Memberships remain until permanent delete.
			expect(contact).not.toBeNull();
			expect(contact?.deletedAt).toBeDefined();
		});
	});
});

// ============ contacts.bulkDelete ============

describe('contacts.bulkDelete', () => {
	it('should delete multiple contacts', async () => {
		const t = convexTest(schema, modules);

		const contactIds: Id<'contacts'>[] = [];

		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				const id = await ctx.db.insert('contacts', createTestContact({
					email: `bulk${i}@example.com`,
				}));
				contactIds.push(id);
			}
		});

		const result = await t.mutation(api.contacts.contacts.bulkDelete, {
			contactIds,
		});

		expect(result.deleted).toBe(3);
		expect(result.failed).toBe(0);

		await t.run(async (ctx) => {
			for (const id of contactIds) {
				const contact = await ctx.db.get(id);
				expect(contact).not.toBeNull();
				expect(contact?.deletedAt).toBeDefined();
			}
		});
	});

	it('should report failed count for missing contacts', async () => {
		const t = convexTest(schema, modules);

		let validId: Id<'contacts'>;

		await t.run(async (ctx) => {
			validId = await ctx.db.insert('contacts', createTestContact({
				email: 'valid@example.com',
			}));
		});

		// Delete the valid contact first so it becomes "not found"
		await t.run(async (ctx) => {
			await ctx.db.delete(validId!);
		});

		const result = await t.mutation(api.contacts.contacts.bulkDelete, {
			contactIds: [validId!],
		});

		expect(result.failed).toBe(1);
		expect(result.deleted).toBe(0);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
	});

	it('should handle non-existent contacts gracefully', async () => {
		const t = convexTest(schema, modules);

		let deletedId: Id<'contacts'>;

		await t.run(async (ctx) => {
			deletedId = await ctx.db.insert('contacts', createTestContact({
				email: 'other@example.com',
			}));
			await ctx.db.delete(deletedId);
		});

		const result = await t.mutation(api.contacts.contacts.bulkDelete, {
			contactIds: [deletedId!],
		});

		expect(result.failed).toBe(1);
		expect(result.deleted).toBe(0);
	});
});

// ============ contacts.list ============

describe('contacts.list', () => {
	it('should return paginated contacts for the organization', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('contacts', createTestContact({
					email: `list${i}@example.com`,
				}));
			}
		});

		const result = await t.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 25, cursor: null },
		});

		expect(result.page).toHaveLength(5);
		expect(result.isDone).toBe(true);
	});

	it('should respect numItems limit', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert('contacts', createTestContact({
					email: `page${i}@example.com`,
				}));
			}
		});

		const result = await t.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 3, cursor: null },
		});

		expect(result.page).toHaveLength(3);
		expect(result.isDone).toBe(false);
	});

	it('should return all contacts', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({
				email: 'mine@example.com',
			}));
			await ctx.db.insert('contacts', createTestContact({
				email: 'also-mine@example.com',
			}));
		});

		const result = await t.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 25, cursor: null },
		});

		expect(result.page).toHaveLength(2);
	});

	it('should return empty page when no contacts exist', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 25, cursor: null },
		});

		expect(result.page).toHaveLength(0);
		expect(result.isDone).toBe(true);
	});
});

// ============ contacts.listByTeam (v1 REST cursor pagination) ============

describe('contacts.listByTeam', () => {
	it('should cursor-paginate through all contacts without a row ceiling', async () => {
		const t = convexTest(schema, modules);

		// Seed more rows than a single page so the cursor must advance.
		await t.run(async (ctx) => {
			for (let i = 0; i < 12; i++) {
				await ctx.db.insert('contacts', createTestContact({
					email: `cursor${String(i).padStart(2, '0')}@example.com`,
					// Distinct creation timestamps so by_created_at order is stable.
					createdAt: 1_700_000_000_000 + i,
				}));
			}
		});

		// First page: returns a cursor and is not done.
		const first = await t.query(internal.contacts.contacts.listByTeam, {
			paginationOpts: { numItems: 5, cursor: null },
		});
		expect(first.contacts).toHaveLength(5);
		expect(first.isDone).toBe(false);
		expect(typeof first.continueCursor).toBe('string');

		// Passing the cursor returns the next page.
		const second = await t.query(internal.contacts.contacts.listByTeam, {
			paginationOpts: { numItems: 5, cursor: first.continueCursor },
		});
		expect(second.contacts).toHaveLength(5);
		expect(second.isDone).toBe(false);

		// Final page: isDone terminates the walk.
		const third = await t.query(internal.contacts.contacts.listByTeam, {
			paginationOpts: { numItems: 5, cursor: second.continueCursor },
		});
		expect(third.contacts).toHaveLength(2);
		expect(third.isDone).toBe(true);

		// Every contact reachable exactly once across the three pages.
		const ids = new Set(
			[...first.contacts, ...second.contacts, ...third.contacts].map((c) => c._id),
		);
		expect(ids.size).toBe(12);
	});

	it('should report the denormalized total via the contactCount counter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', createTestInstanceSettings({
				contactCount: 9999,
			}));
			await ctx.db.insert('contacts', createTestContact({ email: 'only@example.com' }));
		});

		const result = await t.query(internal.contacts.contacts.listByTeam, {
			paginationOpts: { numItems: 25, cursor: null },
		});

		// totalCount comes from the counter, not the (single) page length.
		expect(result.totalCount).toBe(9999);
		expect(result.contacts).toHaveLength(1);
		expect(result.isDone).toBe(true);
	});

	it('should exclude soft-deleted contacts from the page', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'live@example.com' }));
			await ctx.db.insert('contacts', createTestContact({
				email: 'gone@example.com',
				deletedAt: Date.now(),
			}));
		});

		const result = await t.query(internal.contacts.contacts.listByTeam, {
			paginationOpts: { numItems: 25, cursor: null },
		});

		expect(result.contacts).toHaveLength(1);
		expect(result.contacts[0]!.email).toBe('live@example.com');
	});

	it('should paginate the search path with a real cursor', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert('contacts', createTestContact({
					email: `jane${i}@example.com`,
					firstName: 'Jane',
					lastName: `Doe${i}`,
					searchableText: `jane${i}@example.com jane doe${i}`,
				}));
			}
			// A non-matching contact that must not appear in search results.
			await ctx.db.insert('contacts', createTestContact({
				email: 'bob@example.com',
				firstName: 'Bob',
				searchableText: 'bob@example.com bob',
			}));
		});

		const first = await t.query(internal.contacts.contacts.listByTeam, {
			search: 'jane',
			paginationOpts: { numItems: 4, cursor: null },
		});
		expect(first.contacts).toHaveLength(4);
		expect(first.isDone).toBe(false);
		expect(first.contacts.every((c) => c.firstName === 'Jane')).toBe(true);

		const second = await t.query(internal.contacts.contacts.listByTeam, {
			search: 'jane',
			paginationOpts: { numItems: 4, cursor: first.continueCursor },
		});
		expect(second.contacts).toHaveLength(2);
		expect(second.isDone).toBe(true);
		expect(second.contacts.every((c) => c.firstName === 'Jane')).toBe(true);
	});
});

// ============ contacts.count ============

describe('contacts.count', () => {
	it('should return 0 when cached count returns 0', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(api.contacts.contacts.count, {});

		expect(result).toBe(0);
	});
});

// ============ contacts.get ============

describe('contacts.get', () => {
	it('should return a contact by ID', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'getme@example.com',
				firstName: 'Get',
				lastName: 'Me',
			}));
		});

		const contact = await t.query(api.contacts.contacts.get, { contactId: contactId! });

		expect(contact).toBeDefined();
		expect(contact!.email).toBe('getme@example.com');
		expect(contact!.firstName).toBe('Get');
		expect(contact!.lastName).toBe('Me');
	});

	it('should return null for non-existent contact', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'deleted@example.com',
			}));
			await ctx.db.delete(contactId);
		});

		const contact = await t.query(api.contacts.contacts.get, { contactId: contactId! });

		expect(contact).toBeNull();
	});

	it('should return all contact fields', async () => {
		const t = convexTest(schema, modules);

		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'full@example.com',
				firstName: 'Full',
				lastName: 'Fields',
				timezone: 'Europe/Amsterdam',
				language: 'nl',
				source: 'import',
			}));
		});

		const contact = await t.query(api.contacts.contacts.get, { contactId: contactId! });

		expect(contact).toBeDefined();
		expect(contact!.email).toBe('full@example.com');
		expect(contact!.firstName).toBe('Full');
		expect(contact!.lastName).toBe('Fields');
		expect(contact!.timezone).toBe('Europe/Amsterdam');
		expect(contact!.language).toBe('nl');
		expect(contact!.source).toBe('import');
		expect(contact!.createdAt).toBeTypeOf('number');
	});
});
