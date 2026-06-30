import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestTransactionalEmail } from './factories';
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

// ============ transactionalEmails.create ============

describe('transactionalEmails.create', () => {
	it('should create a transactional email with required fields', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(api.transactional.emails.create, {
			name: 'Welcome Email',
			slug: 'welcome-email',
			subject: 'Welcome aboard!',
		});

		expect(id).toBeDefined();

		await t.run(async (ctx) => {
			const email = await ctx.db.get(id);
			expect(email).toBeDefined();
			expect(email!.name).toBe('Welcome Email');
			expect(email!.slug).toBe('welcome-email');
			expect(email!.subject).toBe('Welcome aboard!');
			expect(email!.status).toBe('draft');
			expect(email!.content).toBe('[]');
			expect(email!.defaultLanguage).toBe('en');
			expect(email!.supportedLanguages).toEqual(['en']);
			expect(email!.createdAt).toBeTypeOf('number');
			expect(email!.updatedAt).toBeTypeOf('number');
		});
	});

	it('should set custom defaultLanguage and supportedLanguages', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(api.transactional.emails.create, {
			name: 'German Email',
			slug: 'german-email',
			defaultLanguage: 'de',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(id);
			expect(email!.defaultLanguage).toBe('de');
			expect(email!.supportedLanguages).toEqual(['de']);
		});
	});

	it('should validate slug format - lowercase alphanumeric with hyphens', async () => {
		const t = convexTest(schema, modules);

		// Valid slugs
		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'valid-slug',
			})
		).resolves.toBeDefined();

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'simple',
			})
		).resolves.toBeDefined();

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'multi-part-slug-123',
			})
		).resolves.toBeDefined();
	});

	it('should reject invalid slugs with uppercase', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'Invalid-Slug',
			})
		).rejects.toThrow(/Slug must be lowercase/);
	});

	it('should reject invalid slugs with spaces', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'invalid slug',
			})
		).rejects.toThrow(/Slug must be lowercase/);
	});

	it('should reject invalid slugs with special characters', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Test',
				slug: 'invalid_slug!',
			})
		).rejects.toThrow(/Slug must be lowercase/);
	});

	it('should reject duplicate slugs in same organization', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.transactional.emails.create, {
			name: 'First Email',
			slug: 'welcome',
		});

		await expect(
			t.mutation(api.transactional.emails.create, {
				name: 'Second Email',
				slug: 'welcome',
			})
		).rejects.toThrow(/already exists/);
	});

});

// ============ transactionalEmails.get ============

describe('transactionalEmails.get', () => {
	it('should return email by ID', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'My Email', slug: 'my-email' })
			);
		});

		const email = await t.query(api.transactional.emails.get, { id: emailId! });
		expect(email).toBeDefined();
		expect(email!.name).toBe('My Email');
		expect(email!.slug).toBe('my-email');
	});

	it('should return null for non-existent ID', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			await ctx.db.delete(emailId);
		});

		const email = await t.query(api.transactional.emails.get, { id: emailId! });
		expect(email).toBeNull();
	});
});

// ============ transactionalEmails.getBySlug ============

describe('transactionalEmails.getBySlug', () => {
	it('should return email by organization and slug', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Order Confirmation',
					slug: 'order-confirmation',
				})
			);
		});

		const email = await t.query(api.transactional.emails.getBySlug, {
			slug: 'order-confirmation',
		});

		expect(email).toBeDefined();
		expect(email!.name).toBe('Order Confirmation');
	});

	it('should return null for non-existent slug', async () => {
		const t = convexTest(schema, modules);

		const email = await t.query(api.transactional.emails.getBySlug, {
			slug: 'non-existent',
		});

		expect(email).toBeNull();
	});

});

// ============ transactionalEmails.update ============

describe('transactionalEmails.update', () => {
	it('should partially update name', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Old Name', slug: 'test-email' })
			);
		});

		await t.mutation(api.transactional.emails.update, {
			id: emailId!,
			name: 'New Name',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.name).toBe('New Name');
			expect(email!.slug).toBe('test-email');
		});
	});

	it('should partially update subject and content', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'test-update' })
			);
		});

		await t.mutation(api.transactional.emails.update, {
			id: emailId!,
			subject: 'New Subject',
			content: '[]',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.subject).toBe('New Subject');
			expect(email!.content).toBe('[]');
		});
	});

	it('should validate slug uniqueness on slug change', async () => {
		const t = convexTest(schema, modules);
		let _emailId1: Id<'transactionalEmails'>;
		let emailId2: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			_emailId1 = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'email-one',
				})
			);
			emailId2 = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'email-two',
				})
			);
		});

		await expect(
			t.mutation(api.transactional.emails.update, {
				id: emailId2!,
				slug: 'email-one',
			})
		).rejects.toThrow(/already exists/);
	});

	it('should validate slug format on change', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'valid-slug' })
			);
		});

		await expect(
			t.mutation(api.transactional.emails.update, {
				id: emailId!,
				slug: 'INVALID SLUG',
			})
		).rejects.toThrow(/Slug must be lowercase/);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'to-delete' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.update, {
				id: emailId!,
				name: 'Updated',
			})
		).rejects.toThrow(/not found/);
	});

	it('should update updatedAt timestamp', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;
		let originalUpdatedAt: number;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'timestamp-test', updatedAt: 1000 })
			);
			originalUpdatedAt = 1000;
		});

		await t.mutation(api.transactional.emails.update, {
			id: emailId!,
			name: 'Updated Name',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.updatedAt).toBeGreaterThan(originalUpdatedAt!);
		});
	});
});

// ============ transactionalEmails.publish ============

describe('transactionalEmails.publish', () => {
	it('should set status to published with htmlContent and publishedAt', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'publish-test', status: 'draft' })
			);
		});

		await t.mutation(api.transactional.emails.publish, {
			id: emailId!,
			htmlContent: '<p>Hello World</p>',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.status).toBe('published');
			expect(email!.htmlContent).toBe('<p>Hello World</p>');
			expect(email!.publishedAt).toBeTypeOf('number');
		});
	});

	it('should throw if already published', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'already-published',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		await expect(
			t.mutation(api.transactional.emails.publish, {
				id: emailId!,
				htmlContent: '<p>New content</p>',
			})
		).rejects.toThrow(/already published/);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.publish, {
				id: emailId!,
				htmlContent: '<p>content</p>',
			})
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.unpublish ============

describe('transactionalEmails.unpublish', () => {
	it('should set status back to draft and clear publishedAt', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'unpublish-test',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		await t.mutation(api.transactional.emails.unpublish, { id: emailId! });

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.status).toBe('draft');
			expect(email!.publishedAt).toBeUndefined();
		});
	});

	it('should throw if already draft', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'already-draft', status: 'draft' })
			);
		});

		await expect(
			t.mutation(api.transactional.emails.unpublish, { id: emailId! })
		).rejects.toThrow(/already a draft/);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'ghost-unpublish' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.unpublish, { id: emailId! })
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.duplicate ============

describe('transactionalEmails.duplicate', () => {
	it('should create copy with slug -copy suffix and name (Copy) suffix', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Welcome',
					slug: 'welcome',
					subject: 'Hello!',
					content: '[{"type":"text"}]',
				})
			);
		});

		const copyId = await t.mutation(api.transactional.emails.duplicate, { id: emailId! });

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(copyId);
			expect(copy).toBeDefined();
			expect(copy!.name).toBe('Welcome (Copy)');
			expect(copy!.slug).toBe('welcome-copy');
			expect(copy!.subject).toBe('Hello!');
			expect(copy!.content).toBe('[{"type":"text"}]');
			expect(copy!.status).toBe('draft');
		});
	});

	it('should always set status to draft even when duplicating published email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Published Email',
					slug: 'published',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const copyId = await t.mutation(api.transactional.emails.duplicate, { id: emailId! });

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(copyId);
			expect(copy!.status).toBe('draft');
		});
	});

	it('should handle slug collision by appending -copy-2, -copy-3, etc.', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Original', slug: 'email' })
			);
			// Pre-create the -copy slug to force collision
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Existing Copy', slug: 'email-copy' })
			);
		});

		const copyId = await t.mutation(api.transactional.emails.duplicate, { id: emailId! });

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(copyId);
			expect(copy!.slug).toBe('email-copy-2');
		});
	});

	it('should handle multiple slug collisions', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Original', slug: 'email' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Copy 1', slug: 'email-copy' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ name: 'Copy 2', slug: 'email-copy-2' })
			);
		});

		const copyId = await t.mutation(api.transactional.emails.duplicate, { id: emailId! });

		await t.run(async (ctx) => {
			const copy = await ctx.db.get(copyId);
			expect(copy!.slug).toBe('email-copy-3');
		});
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'dup-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.duplicate, { id: emailId! })
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.remove ============

describe('transactionalEmails.remove', () => {
	it('should delete the email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'to-remove' })
			);
		});

		await t.mutation(api.transactional.emails.remove, { id: emailId! });

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email).toBeNull();
		});
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'remove-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.remove, { id: emailId! })
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.countByStatus ============

describe('transactionalEmails.countByStatus', () => {
	it('should count draft and published correctly', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'draft-1', status: 'draft' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'draft-2', status: 'draft' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'published-1',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const counts = await t.query(api.transactional.emails.countByStatus, {
		});

		expect(counts.total).toBe(3);
		expect(counts.draft).toBe(2);
		expect(counts.published).toBe(1);
	});

	it('should return zeros when no emails exist', async () => {
		const t = convexTest(schema, modules);

		const counts = await t.query(api.transactional.emails.countByStatus, {
		});

		expect(counts.total).toBe(0);
		expect(counts.draft).toBe(0);
		expect(counts.published).toBe(0);
	});
});

// ============ transactionalEmails.list ============

describe('transactionalEmails.list', () => {
	it('should list all emails', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'list-1' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'list-2' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'list-3' })
			);
		});

		const results = await t.query(api.transactional.emails.list, {
		});

		expect(results).toHaveLength(3);
	});

	it('should filter by status draft', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'status-draft', status: 'draft' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'status-published',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const drafts = await t.query(api.transactional.emails.list, {
			status: 'draft',
		});

		expect(drafts).toHaveLength(1);
		expect(drafts[0]!.status).toBe('draft');
	});

	it('should filter by status published', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'filter-draft', status: 'draft' })
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'filter-published',
					status: 'published',
					publishedAt: Date.now(),
				})
			);
		});

		const published = await t.query(api.transactional.emails.list, {
			status: 'published',
		});

		expect(published).toHaveLength(1);
		expect(published[0]!.status).toBe('published');
	});

	it('should search by name (case-insensitive)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Welcome Email',
					slug: 'search-welcome',
					subject: 'Hi',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Password Reset',
					slug: 'search-reset',
					subject: 'Reset',
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			search: 'welcome',
		});

		expect(results).toHaveLength(1);
		expect(results[0]!.name).toBe('Welcome Email');
	});

	it('should search by slug', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Email A',
					slug: 'order-confirmation',
					subject: 'Order',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Email B',
					slug: 'receipt',
					subject: 'Receipt',
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			search: 'order-confirmation',
		});

		expect(results).toHaveLength(1);
		expect(results[0]!.slug).toBe('order-confirmation');
	});

	it('should search by subject (case-insensitive)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Email',
					slug: 'subject-search-1',
					subject: 'Your Order Has Shipped',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Other',
					slug: 'subject-search-2',
					subject: 'Welcome aboard',
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			search: 'SHIPPED',
		});

		expect(results).toHaveLength(1);
		expect(results[0]!.subject).toBe('Your Order Has Shipped');
	});

	it('should sort by updatedAt desc by default', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Old',
					slug: 'sort-old',
					updatedAt: 1000,
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'New',
					slug: 'sort-new',
					updatedAt: 3000,
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Mid',
					slug: 'sort-mid',
					updatedAt: 2000,
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
		});

		expect(results[0]!.name).toBe('New');
		expect(results[1]!.name).toBe('Mid');
		expect(results[2]!.name).toBe('Old');
	});

	it('should sort by createdAt asc', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Second',
					slug: 'created-2',
					createdAt: 2000,
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'First',
					slug: 'created-1',
					createdAt: 1000,
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			sortBy: 'createdAt',
			sortOrder: 'asc',
		});

		expect(results[0]!.name).toBe('First');
		expect(results[1]!.name).toBe('Second');
	});

	it('should sort by name asc', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Charlie',
					slug: 'name-charlie',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Alpha',
					slug: 'name-alpha',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Bravo',
					slug: 'name-bravo',
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			sortBy: 'name',
			sortOrder: 'asc',
		});

		expect(results[0]!.name).toBe('Alpha');
		expect(results[1]!.name).toBe('Bravo');
		expect(results[2]!.name).toBe('Charlie');
	});

	it('should sort by name desc', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Alpha',
					slug: 'desc-alpha',
				})
			);
			await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					name: 'Charlie',
					slug: 'desc-charlie',
				})
			);
		});

		const results = await t.query(api.transactional.emails.list, {
			sortBy: 'name',
			sortOrder: 'desc',
		});

		expect(results[0]!.name).toBe('Charlie');
		expect(results[1]!.name).toBe('Alpha');
	});
});

// ============ transactionalEmails.updateSchema ============

describe('transactionalEmails.updateSchema', () => {
	it('should validate and store valid schema', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'schema-test' })
			);
		});

		const validSchema: Record<string, 'string' | 'number' | 'boolean' | 'date'> = {
			firstName: 'string',
			orderTotal: 'number',
			isVip: 'boolean',
			orderDate: 'date',
		};

		await t.mutation(api.transactional.emails.updateSchema, {
			id: emailId!,
			dataVariablesSchema: validSchema,
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.dataVariablesSchema).toEqual(validSchema);
		});
	});

	it('should reject invalid variable names - starting with number', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'bad-varname' })
			);
		});

		await expect(
			t.mutation(api.transactional.emails.updateSchema, {
				id: emailId!,
				dataVariablesSchema: { '123abc': 'string' },
			})
		).rejects.toThrow(/Invalid variable name/);
	});

	it('should reject invalid variable names - special characters', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'bad-varname-special' })
			);
		});

		await expect(
			t.mutation(api.transactional.emails.updateSchema, {
				id: emailId!,
				dataVariablesSchema: { 'my-var': 'string' },
			})
		).rejects.toThrow(/Invalid variable name/);
	});

	it('should reject invalid types', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'bad-type' })
			);
		});

		await expect(
			t.mutation(api.transactional.emails.updateSchema, {
				id: emailId!,
				dataVariablesSchema: { name: 'array' } as unknown as Record<string, 'string' | 'number' | 'boolean' | 'date'>,
			})
		).rejects.toThrow(/Invalid type/);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'schema-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.emails.updateSchema, {
				id: emailId!,
				dataVariablesSchema: { name: 'string' },
			})
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.addTranslation ============

describe('transactionalEmails.addTranslation', () => {
	it('should add language to supportedLanguages and create translation entry', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-add',
					subject: 'Hello',
					content: JSON.stringify([
						{ id: 'block-1', type: 'text', content: { html: '<p>Hello world</p>' } },
					]),
					defaultLanguage: 'en',
					supportedLanguages: ['en'],
				})
			);
		});

		await t.mutation(api.transactional.translations.addTranslation, {
			id: emailId!,
			language: 'de',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.supportedLanguages).toContain('de');
			expect(email!.supportedLanguages).toContain('en');

			const translations = JSON.parse(email!.translations!);
			expect(translations.de).toBeDefined();
			expect(translations.de.subject).toBe('Hello');
			expect(translations.de.blocks['block-1']).toBeDefined();
			expect(translations.de.blocks['block-1'].html).toBe('<p>Hello world</p>');
		});
	});

	it('should throw if language already exists', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-dup',
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de'],
					translations: JSON.stringify({
						de: { subject: 'Hallo', blocks: {} },
					}),
				})
			);
		});

		await expect(
			t.mutation(api.transactional.translations.addTranslation, {
				id: emailId!,
				language: 'de',
			})
		).rejects.toThrow(/already/);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'i18n-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.translations.addTranslation, {
				id: emailId!,
				language: 'fr',
			})
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.updateTranslation ============

describe('transactionalEmails.updateTranslation', () => {
	it('should update subject and blocks for non-default language', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-update',
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de'],
					translations: JSON.stringify({
						de: { subject: 'Hallo', blocks: { 'b1': { html: 'Alt' } } },
					}),
				})
			);
		});

		await t.mutation(api.transactional.translations.updateTranslation, {
			id: emailId!,
			language: 'de',
			subject: 'Willkommen',
			blocks: JSON.stringify({ 'b1': { html: 'Neu' } }),
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			const translations = JSON.parse(email!.translations!);
			expect(translations.de.subject).toBe('Willkommen');
			expect(translations.de.blocks['b1'].html).toBe('Neu');
		});
	});

	it('should update main subject for default language', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-default-update',
					subject: 'Old Subject',
					defaultLanguage: 'en',
					supportedLanguages: ['en'],
				})
			);
		});

		await t.mutation(api.transactional.translations.updateTranslation, {
			id: emailId!,
			language: 'en',
			subject: 'New Subject',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.subject).toBe('New Subject');
		});
	});

	it('should throw if translation does not exist for non-default language', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-no-translation',
					defaultLanguage: 'en',
					supportedLanguages: ['en'],
				})
			);
		});

		await expect(
			t.mutation(api.transactional.translations.updateTranslation, {
				id: emailId!,
				language: 'fr',
				subject: 'Bonjour',
			})
		).rejects.toThrow(/not found/i);
	});

	it('should throw for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'i18n-update-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		await expect(
			t.mutation(api.transactional.translations.updateTranslation, {
				id: emailId!,
				language: 'en',
				subject: 'test',
			})
		).rejects.toThrow(/not found/);
	});
});

// ============ transactionalEmails.removeTranslation ============

describe('transactionalEmails.removeTranslation', () => {
	it('should remove language from supportedLanguages and translations', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-remove',
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de', 'fr'],
					translations: JSON.stringify({
						de: { subject: 'Hallo', blocks: {} },
						fr: { subject: 'Bonjour', blocks: {} },
					}),
				})
			);
		});

		await t.mutation(api.transactional.translations.removeTranslation, {
			id: emailId!,
			language: 'de',
		});

		await t.run(async (ctx) => {
			const email = await ctx.db.get(emailId!);
			expect(email!.supportedLanguages).toEqual(['en', 'fr']);
			const translations = JSON.parse(email!.translations!);
			expect(translations.de).toBeUndefined();
			expect(translations.fr).toBeDefined();
		});
	});

	it('should throw when removing default language', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-remove-default',
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de'],
				})
			);
		});

		await expect(
			t.mutation(api.transactional.translations.removeTranslation, {
				id: emailId!,
				language: 'en',
			})
		).rejects.toThrow(/Cannot remove the default language/);
	});

	it('should throw if translation does not exist', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'i18n-remove-nonexistent',
					defaultLanguage: 'en',
					supportedLanguages: ['en'],
				})
			);
		});

		await expect(
			t.mutation(api.transactional.translations.removeTranslation, {
				id: emailId!,
				language: 'es',
			})
		).rejects.toThrow(/not found/i);
	});
});

// ============ transactionalEmails.getForLanguage ============

describe('transactionalEmails.getForLanguage', () => {
	it('should return default content when requesting default language', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'lang-default',
					subject: 'English Subject',
					content: JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'English' } }]),
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de'],
					translations: JSON.stringify({
						de: {
							subject: 'German Subject',
							blocks: { 'b1': { html: 'Deutsch' } },
						},
					}),
				})
			);
		});

		const result = await t.query(api.transactional.translations.getForLanguage, {
			id: emailId!,
			language: 'en',
		});

		expect(result).toBeDefined();
		expect(result!.resolvedLanguage).toBe('en');
		expect(result!.subject).toBe('English Subject');
	});

	it('should return translated content when translation exists', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'lang-translated',
					subject: 'English Subject',
					content: JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Hello' } }]),
					defaultLanguage: 'en',
					supportedLanguages: ['en', 'de'],
					translations: JSON.stringify({
						de: {
							subject: 'Deutscher Betreff',
							blocks: { 'b1': { html: 'Hallo' } },
						},
					}),
				})
			);
		});

		const result = await t.query(api.transactional.translations.getForLanguage, {
			id: emailId!,
			language: 'de',
		});

		expect(result).toBeDefined();
		expect(result!.resolvedLanguage).toBe('de');
		expect(result!.subject).toBe('Deutscher Betreff');
		// Content should have merged translation
		const content = JSON.parse(result!.content);
		expect(content[0].content.html).toBe('Hallo');
	});

	it('should fall back to default when translation is missing', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'lang-fallback',
					subject: 'English Subject',
					content: JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'English' } }]),
					defaultLanguage: 'en',
					supportedLanguages: ['en'],
				})
			);
		});

		const result = await t.query(api.transactional.translations.getForLanguage, {
			id: emailId!,
			language: 'fr',
		});

		expect(result).toBeDefined();
		expect(result!.resolvedLanguage).toBe('en');
		expect(result!.subject).toBe('English Subject');
	});

	it('should return null for non-existent email', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ slug: 'lang-ghost' })
			);
			await ctx.db.delete(emailId);
		});

		const result = await t.query(api.transactional.translations.getForLanguage, {
			id: emailId!,
		});

		expect(result).toBeNull();
	});

	it('should default to default language when no language is specified', async () => {
		const t = convexTest(schema, modules);
		let emailId: Id<'transactionalEmails'>;

		await t.run(async (ctx) => {
			emailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					slug: 'lang-no-arg',
					subject: 'Default Subject',
					defaultLanguage: 'en',
				})
			);
		});

		const result = await t.query(api.transactional.translations.getForLanguage, {
			id: emailId!,
		});

		expect(result).toBeDefined();
		expect(result!.resolvedLanguage).toBe('en');
		expect(result!.subject).toBe('Default Subject');
	});
});
