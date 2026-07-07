/**
 * Regression locks for just-shipped inbox + contacts fixes.
 *
 * Sources under test:
 *   - inbox/queries.ts      (listThreads — real keyset pagination + admin gate)
 *   - inbox/mutations.ts    (assignThread — non-member assignee rejection)
 *   - contacts/contacts.ts  (bulkDelete per-contact audit; update audit + length limits)
 *   - contacts/identities.ts(mergeContacts — audit row before source hard-delete)
 *
 * These pin behaviour that the pre-deepening code got wrong:
 *   - listThreads ignored `args.cursor` (load-more re-returned page 1) and
 *     post-filtered `assignedToMe` after .take() (dropped assigned rows).
 *   - assignThread accepted any free-form `assignedTo` string.
 *   - bulkDelete / update / mergeContacts emitted no audit rows.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures, createTestContact } from './factories';

// Mutable session so a single test can switch between owner/admin/editor and
// between user ids (mirrors the chat.integration.test.ts pattern).
const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-owner', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		// requireOrgMember is the floor for authedMutation; getMutationContext
		// wraps it. Both must surface the current mocked user/role.
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		// authedMutation handlers gate on requireOrgPermission; run the real
		// role→permission map so an editor is rejected by the genuine check.
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				const mod: typeof import('../lib/sessionOrganization') = actual;
				mod.requirePermission(
					mod.hasPermission(
						sessionMock.user.role as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1]
					),
					message
				);
				return { userId: sessionMock.user.id, role: sessionMock.user.role };
			}),
		// adminMutation's wrapper calls requireAdminContext; reject editors so the
		// role gate is exercised end-to-end.
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (sessionMock.user.role === 'editor') {
				throw new Error('forbidden');
			}
			return { userId: sessionMock.user.id, role: sessionMock.user.role };
		}),
		isActiveOrgMember: vi.fn().mockImplementation(async () => true),
		// listThreads is a publicQuery with an in-handler role check; it reads the
		// session straight off this helper.
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			activeOrganizationId: 'org-singleton',
			role: sessionMock.user.role,
		})),
		// hasPermission / requirePermission are intentionally NOT overridden — the
		// real role→permission map (contacts:manage = owner/admin) gates the
		// contacts mutations, so an editor is rejected by the genuine check.
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
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
);

/** Seed a userProfiles row so an assignee resolves via by_auth_user_id. */
const seedProfile = async (t: TestConvex<typeof schema>, authUserId: string) => {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('userProfiles', {
			authUserId,
			email: `${authUserId}@example.com`,
			name: authUserId,
			createdAt: now,
			updatedAt: now,
		});
	});
};

/** Insert a conversationThread; returns its id. */
const seedThread = async (
	t: TestConvex<typeof schema>,
	overrides: Partial<{
		status: 'open' | 'waiting' | 'resolved' | 'closed';
		assignedTo: string;
		lastMessageAt: number;
	}> = {}
) =>
	t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('conversationThreads', {
			subject: 'ticket',
			normalizedSubject: 'ticket',
			contactIdentifier: 'customer@example.com',
			status: overrides.status ?? 'open',
			...(overrides.assignedTo !== undefined ? { assignedTo: overrides.assignedTo } : {}),
			messageCount: 1,
			lastMessageAt: overrides.lastMessageAt ?? now,
			firstMessageAt: now,
			createdAt: now,
		});
	});

const auditRows = (t: TestConvex<typeof schema>, action: string) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter((r) => r.action === action)
	);

beforeEach(() => {
	setUser('user-owner', 'owner');
});

// ============ inbox.listThreads — real cursor pagination ============

describe('inbox.listThreads pagination', () => {
	it('paginates with no page overlap and full coverage (the old bug re-returned page 1)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		setUser('user-owner', 'owner');

		// Seed 7 threads with strictly increasing lastMessageAt so ordering is
		// deterministic (by_last_message_at desc).
		const base = Date.now();
		const ids: Id<'conversationThreads'>[] = [];
		for (let i = 0; i < 7; i++) {
			ids.push(await seedThread(t, { lastMessageAt: base + i * 1000 }));
		}

		const page1 = await t.query(api.inbox.queries.listThreads, { limit: 3 });
		expect(page1.threads).toHaveLength(3);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await t.query(api.inbox.queries.listThreads, {
			limit: 3,
			cursor: page1.nextCursor!,
		});
		expect(page2.threads).toHaveLength(3);
		expect(page2.nextCursor).not.toBeNull();

		const page3 = await t.query(api.inbox.queries.listThreads, {
			limit: 3,
			cursor: page2.nextCursor!,
		});
		expect(page3.threads).toHaveLength(1);
		expect(page3.nextCursor).toBeNull();

		const seen = [
			...page1.threads.map((x) => x._id),
			...page2.threads.map((x) => x._id),
			...page3.threads.map((x) => x._id),
		];
		// No overlap: every returned id is distinct.
		expect(new Set(seen).size).toBe(7);
		// Full coverage: every seeded thread appears exactly once.
		expect(new Set(seen)).toEqual(new Set(ids));
	});

	it("filter='mine' returns only the caller assigned threads, paginated correctly", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		setUser('user-owner', 'owner');

		const base = Date.now();
		// 5 assigned to the caller, 3 assigned to someone else.
		const mine: Id<'conversationThreads'>[] = [];
		for (let i = 0; i < 5; i++) {
			mine.push(await seedThread(t, { assignedTo: 'user-owner', lastMessageAt: base + i * 1000 }));
		}
		for (let i = 0; i < 3; i++) {
			await seedThread(t, { assignedTo: 'someone-else', lastMessageAt: base + i * 1000 });
		}

		const page1 = await t.query(api.inbox.queries.listThreads, {
			filter: 'mine',
			limit: 2,
		});
		expect(page1.threads).toHaveLength(2);
		expect(page1.threads.every((x) => x.assignedTo === 'user-owner')).toBe(true);
		expect(page1.nextCursor).not.toBeNull();

		const collected: Id<'conversationThreads'>[] = page1.threads.map((x) => x._id);
		let cursor = page1.nextCursor;
		// Drain the rest of the assigned pages.
		while (cursor) {
			const next = await t.query(api.inbox.queries.listThreads, {
				filter: 'mine',
				limit: 2,
				cursor,
			});
			expect(next.threads.every((x) => x.assignedTo === 'user-owner')).toBe(true);
			collected.push(...next.threads.map((x) => x._id));
			cursor = next.nextCursor;
		}

		// All 5 of the caller's threads surface (the old post-take filter dropped
		// assigned rows beyond the first window); none of the foreign ones do.
		expect(new Set(collected)).toEqual(new Set(mine));
		expect(collected).toHaveLength(5);
	});

	it('is admin-only — returns an empty page for a non-admin (editor)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await seedThread(t, {});

		setUser('user-editor', 'editor');
		const result = await t.query(api.inbox.queries.listThreads, { limit: 10 });
		expect(result.threads).toEqual([]);
		expect(result.nextCursor).toBeNull();
	});
});

// ============ inbox.assignThread — assignee validation ============

describe('inbox.assignThread', () => {
	it('rejects an assignedTo with no userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		setUser('user-owner', 'owner');
		const threadId = await seedThread(t, {});

		await expect(
			t.mutation(api.inbox.mutations.assignThread, {
				threadId,
				assignedTo: 'ghost-user',
			})
		).rejects.toThrow();

		// The thread must remain unassigned.
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBeUndefined();
	});

	it('accepts an assignee that has a real userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		setUser('user-owner', 'owner');
		await seedProfile(t, 'real-member');
		const threadId = await seedThread(t, {});

		const res = await t.mutation(api.inbox.mutations.assignThread, {
			threadId,
			assignedTo: 'real-member',
		});
		expect(res.success).toBe(true);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBe('real-member');
	});

	it('allows unassign (undefined assignedTo) without a profile lookup', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		setUser('user-owner', 'owner');
		// Start assigned to a member, then unassign.
		await seedProfile(t, 'real-member');
		const threadId = await seedThread(t, { assignedTo: 'real-member' });

		const res = await t.mutation(api.inbox.mutations.assignThread, {
			threadId,
			// assignedTo omitted → unassign
		});
		expect(res.success).toBe(true);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBeUndefined();
	});
});

// ============ contacts.bulkDelete — per-contact audit row ============

describe('contacts.bulkDelete', () => {
	it('writes one contact.deleted auditLogs row per contact', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');

		const c1 = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }))
		);
		const c2 = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }))
		);

		const result = await t.mutation(api.contacts.contacts.bulkDelete, {
			contactIds: [c1, c2],
		});
		expect(result.deleted).toBe(2);

		const rows = await auditRows(t, 'contact.deleted');
		expect(rows).toHaveLength(2);
		const resourceIds = new Set(rows.map((r) => r.resourceId));
		expect(resourceIds).toEqual(new Set<string>([c1, c2]));
	});

	it('is gated to owners/admins — an editor cannot bulk-delete', async () => {
		const t = convexTest(schema, modules);
		setUser('user-editor', 'editor');

		const c1 = await t.run(async (ctx) => ctx.db.insert('contacts', createTestContact()));

		await expect(
			t.mutation(api.contacts.contacts.bulkDelete, { contactIds: [c1] })
		).rejects.toThrow();

		expect(await auditRows(t, 'contact.deleted')).toHaveLength(0);
	});
});

// ============ contacts.identities.mergeContacts — audit before hard-delete ============

describe('contacts.identities.mergeContacts', () => {
	it('writes a contact.merged audit row and removes the source contact', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');

		const target = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'keep@example.com' }))
		);
		const source = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'merge-away@example.com' }))
		);

		const returned = await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: target,
			sourceContactId: source,
		});
		expect(returned).toBe(target);

		// Source is hard-deleted; target survives.
		await t.run(async (ctx) => {
			expect(await ctx.db.get(source)).toBeNull();
			expect(await ctx.db.get(target)).not.toBeNull();
		});

		const rows = await auditRows(t, 'contact.merged');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.resourceId).toBe(target);
		expect(rows[0]!.details?.['sourceContactId']).toBe(source);
		expect(rows[0]!.details?.['sourceEmail']).toBe('merge-away@example.com');
	});
});

// ============ contacts.update — audit + string-length limits ============

describe('contacts.update', () => {
	it('writes a contact.updated audit row recording the changed properties', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');

		const contactId = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ firstName: 'Old', lastName: 'Name' }))
		);

		await t.mutation(api.contacts.contacts.update, {
			contactId,
			firstName: 'New',
		});

		const updated = await t.run(async (ctx) => ctx.db.get(contactId));
		expect(updated?.firstName).toBe('New');

		const rows = await auditRows(t, 'contact.updated');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.resourceId).toBe(contactId);
		expect(String(rows[0]!.details?.['changedProperties'])).toContain('firstName');
	});

	it('does NOT write an audit row when nothing actually changes', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');

		const contactId = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ firstName: 'Same' }))
		);

		await t.mutation(api.contacts.contacts.update, {
			contactId,
			firstName: 'Same',
		});

		expect(await auditRows(t, 'contact.updated')).toHaveLength(0);
	});

	it('enforces string-length limits (firstName over 200 chars is rejected)', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');

		const contactId = await t.run(async (ctx) => ctx.db.insert('contacts', createTestContact()));

		await expect(
			t.mutation(api.contacts.contacts.update, {
				contactId,
				firstName: 'x'.repeat(201),
			})
		).rejects.toThrow(/at most 200 characters/);

		// No audit row for a rejected update.
		expect(await auditRows(t, 'contact.updated')).toHaveLength(0);
	});

	it('is gated to owners/admins — an editor cannot update a contact', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.run(async (ctx) => ctx.db.insert('contacts', createTestContact()));

		setUser('user-editor', 'editor');
		await expect(
			t.mutation(api.contacts.contacts.update, {
				contactId,
				firstName: 'Nope',
			})
		).rejects.toThrow();
	});
});
