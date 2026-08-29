/**
 * Saved searches (mail/savedSearches) — CRUD, pinning and mailbox ownership.
 *
 * Ownership is enforced by `requireMailboxAccess`: a non-owner (different userId,
 * non-admin role) must not read or mutate another mailbox's saved searches.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agentSecurity') &&
				!path.includes('agentContext') &&
				!path.includes('agentClassifier') &&
				!path.includes('agentDrafter') &&
				!path.includes('agentRouter') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/shared') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

async function seedMailbox(
	t: ReturnType<typeof convexTest>,
	userId: string
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org-1',
			address: `${userId}@hinterland.camp`,
			domain: 'hinterland.camp',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

describe('mail.savedSearches CRUD', () => {
	it('creates, lists, updates and removes a saved search', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');

		const id = await t.mutation(api.mail.savedSearches.create, {
			mailboxId,
			name: 'Unread from Ines',
			rawQuery: 'is:unread from:ines',
		});

		let list = await t.query(api.mail.savedSearches.list, { mailboxId });
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe('Unread from Ines');
		expect(list[0]?.rawQuery).toBe('is:unread from:ines');
		// Absent = today's behavior: nothing appears in the rail until pinned.
		expect(list[0]?.isPinned).toBe(false);
		expect(list[0]?.order).toBe(0);

		await t.mutation(api.mail.savedSearches.update, {
			savedSearchId: id,
			name: 'Ines, unread',
			isPinned: true,
		});
		list = await t.query(api.mail.savedSearches.list, { mailboxId });
		expect(list[0]?.name).toBe('Ines, unread');
		expect(list[0]?.isPinned).toBe(true);
		expect(list[0]?.rawQuery).toBe('is:unread from:ines');

		await t.mutation(api.mail.savedSearches.remove, { savedSearchId: id });
		expect(await t.query(api.mail.savedSearches.list, { mailboxId })).toHaveLength(0);
	});

	it('appends each new entry after the last, and lists in that order', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		for (const name of ['first', 'second', 'third']) {
			await t.mutation(api.mail.savedSearches.create, { mailboxId, name, rawQuery: name });
		}
		const list = await t.query(api.mail.savedSearches.list, { mailboxId });
		expect(list.map((row) => row.name)).toEqual(['first', 'second', 'third']);
		expect(list.map((row) => row.order)).toEqual([0, 1, 2]);
	});

	it('reorders on an explicit order patch', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		const first = await t.mutation(api.mail.savedSearches.create, {
			mailboxId,
			name: 'first',
			rawQuery: 'a',
		});
		await t.mutation(api.mail.savedSearches.create, {
			mailboxId,
			name: 'second',
			rawQuery: 'b',
		});
		await t.mutation(api.mail.savedSearches.update, { savedSearchId: first, order: 5 });
		const list = await t.query(api.mail.savedSearches.list, { mailboxId });
		expect(list.map((row) => row.name)).toEqual(['second', 'first']);
	});

	it('rejects an empty name or an empty query', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		await expect(
			t.mutation(api.mail.savedSearches.create, { mailboxId, name: '   ', rawQuery: 'a' })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.savedSearches.create, { mailboxId, name: 'x', rawQuery: '  ' })
		).rejects.toThrow();
	});

	it('rejects a duplicate name regardless of casing', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		await t.mutation(api.mail.savedSearches.create, {
			mailboxId,
			name: 'Invoices',
			rawQuery: 'has:attachment',
		});
		await expect(
			t.mutation(api.mail.savedSearches.create, {
				mailboxId,
				name: 'invoices',
				rawQuery: 'has:attachment',
			})
		).rejects.toThrow();
	});

	it('rejects an over-long name or query', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		await expect(
			t.mutation(api.mail.savedSearches.create, {
				mailboxId,
				name: 'n'.repeat(81),
				rawQuery: 'a',
			})
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.savedSearches.create, {
				mailboxId,
				name: 'ok',
				rawQuery: 'q'.repeat(513),
			})
		).rejects.toThrow();
	});
});

describe('mail.savedSearches ownership', () => {
	it("does not list another user's saved searches", async () => {
		const t = convexTest(schema, modules);
		const mineId = await seedMailbox(t, 'user-A');
		await t.mutation(api.mail.savedSearches.create, {
			mailboxId: mineId,
			name: 'mine',
			rawQuery: 'is:unread',
		});

		sessionMocks.userId = 'user-B';
		expect(await t.query(api.mail.savedSearches.list, { mailboxId: mineId })).toEqual([]);
	});

	it('refuses to create in a mailbox the caller cannot reach', async () => {
		const t = convexTest(schema, modules);
		const mineId = await seedMailbox(t, 'user-A');
		sessionMocks.userId = 'user-B';
		await expect(
			t.mutation(api.mail.savedSearches.create, {
				mailboxId: mineId,
				name: 'theirs',
				rawQuery: 'is:unread',
			})
		).rejects.toThrow();
	});

	it("refuses to update or remove another user's saved search", async () => {
		const t = convexTest(schema, modules);
		const mineId = await seedMailbox(t, 'user-A');
		const id = await t.mutation(api.mail.savedSearches.create, {
			mailboxId: mineId,
			name: 'mine',
			rawQuery: 'is:unread',
		});

		sessionMocks.userId = 'user-B';
		await expect(
			t.mutation(api.mail.savedSearches.update, { savedSearchId: id, isPinned: true })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.savedSearches.remove, { savedSearchId: id })
		).rejects.toThrow();

		sessionMocks.userId = 'user-A';
		const list = await t.query(api.mail.savedSearches.list, { mailboxId: mineId });
		expect(list).toHaveLength(1);
		expect(list[0]?.isPinned).toBe(false);
	});
});
