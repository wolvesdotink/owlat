/**
 * Per-mailbox snippets (mail/snippets) — CRUD + mailbox ownership.
 *
 * Ownership is enforced by `loadOwnedMailbox`: a non-owner (different userId,
 * non-admin role) must not read or mutate another mailbox's snippets.
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

describe('mail.snippets CRUD', () => {
	it('creates, lists, updates and removes a snippet', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');

		const id = await t.mutation(api.mail.snippets.create, {
			mailboxId,
			name: 'Thanks',
			shortcut: 'ty',
			bodyHtml: '<p>Hi {{firstName}}, thanks!</p>',
		});

		let list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe('Thanks');
		expect(list[0]?.shortcut).toBe('ty');
		expect(list[0]?.bodyHtml).toContain('{{firstName}}');

		await t.mutation(api.mail.snippets.update, {
			snippetId: id,
			name: 'Thank you',
			shortcut: 'tyvm',
		});
		list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list[0]?.name).toBe('Thank you');
		expect(list[0]?.shortcut).toBe('tyvm');

		await t.mutation(api.mail.snippets.remove, { snippetId: id });
		list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list).toHaveLength(0);
	});

	it('trims the name and rejects an empty one', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		await expect(
			t.mutation(api.mail.snippets.create, {
				mailboxId,
				name: '   ',
				shortcut: 'x',
				bodyHtml: '<p>hi</p>',
			})
		).rejects.toThrow();
	});

	it('sanitizes body HTML on save (strips scripts)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		const id = await t.mutation(api.mail.snippets.create, {
			mailboxId,
			name: 'Evil',
			shortcut: 'x',
			bodyHtml: '<p>ok</p><script>alert(1)</script>',
		});
		const list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list[0]?._id).toBe(id);
		expect(list[0]?.bodyHtml).not.toContain('<script');
		expect(list[0]?.bodyHtml).toContain('ok');
	});
});

describe('mail.snippets mailbox ownership', () => {
	it("a non-owner editor cannot list another user's snippets", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');
		await t.mutation(api.mail.snippets.create, {
			mailboxId,
			name: 'Mine',
			shortcut: 'm',
			bodyHtml: '<p>x</p>',
		});

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		const list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list).toEqual([]);
	});

	it("a non-owner editor cannot create in another user's mailbox", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(
			t.mutation(api.mail.snippets.create, {
				mailboxId,
				name: 'Intruder',
				shortcut: 'i',
				bodyHtml: '<p>x</p>',
			})
		).rejects.toThrow();
	});

	it('an admin can access any mailbox in the org', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-A');

		sessionMocks.userId = 'admin-user';
		sessionMocks.role = 'admin';
		const id = await t.mutation(api.mail.snippets.create, {
			mailboxId,
			name: 'Admin note',
			shortcut: 'a',
			bodyHtml: '<p>x</p>',
		});
		expect(id).toBeDefined();
		const list = await t.query(api.mail.snippets.list, { mailboxId });
		expect(list).toHaveLength(1);
	});
});
