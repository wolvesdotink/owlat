/**
 * Saved replies (mail/savedReplies): personal and shared scopes, the team-inbox
 * restriction, rows written before saved replies, usage counts, and the
 * previous release's snippet API still respecting the new rules.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { api } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { modules } from '../../__tests__/testModules';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

type Harness = ReturnType<typeof convexTest>;

async function harness(flags: FeatureFlagKey[] = ['mail.external']): Promise<Harness> {
	const t = convexTest(schema, modules);
	await enableFeatures(t, flags);
	return t;
}

async function seedMailbox(
	t: Harness,
	userId: string,
	opts: { scope?: 'shared' | 'seed'; members?: string[] } = {}
): Promise<Id<'mailboxes'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org-1',
			address: `${userId}-${opts.scope ?? 'personal'}-${now}@owlat.test`,
			domain: 'owlat.test',
			...(opts.scope ? { scope: opts.scope } : {}),
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const member of opts.members ?? []) {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: id,
				authUserId: member,
				role: 'member',
				addedBy: userId,
				createdAt: now,
			});
		}
		return id;
	});
}

/** A row the way the previous release wrote it: only a mailbox. */
async function seedLegacy(t: Harness, mailboxId: Id<'mailboxes'>, name: string) {
	return t.run((ctx) =>
		ctx.db.insert('mailSnippets', {
			mailboxId,
			name,
			shortcut: name.toLowerCase(),
			bodyHtml: `<p>${name}</p>`,
			createdAt: 1,
			updatedAt: 1,
		})
	);
}

function as(userId: string, role: 'owner' | 'admin' | 'editor' = 'editor') {
	sessionMocks.userId = userId;
	sessionMocks.role = role;
}

const names = (replies: { name: string }[]) => replies.map((r) => r.name).sort();

beforeEach(() => as('user-A'));

describe('personal saved replies', () => {
	it('are their owner’s alone, in every composer', async () => {
		const t = await harness();
		const id = await t.mutation(api.mail.savedReplies.create, {
			scope: 'personal',
			name: ' Refund ',
			shortcut: ';Refund Policy',
			bodyHtml: '<p>Hi {{contact.firstName}}</p><script>x()</script>',
		});

		const mine = await t.query(api.mail.savedReplies.listMine, {});
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({
			_id: id,
			name: 'Refund',
			shortcut: 'refund-policy',
			scope: 'personal',
			useCount: 0,
		});
		expect(mine[0]?.bodyHtml).toContain('{{contact.firstName}}');
		expect(mine[0]?.bodyHtml).not.toContain('<script');
		expect(names(await t.query(api.mail.savedReplies.listForComposer, {}))).toEqual(['Refund']);

		as('user-B', 'admin');
		expect(await t.query(api.mail.savedReplies.listMine, {})).toEqual([]);
		expect(await t.query(api.mail.savedReplies.listForComposer, {})).toEqual([]);
		await expect(
			t.mutation(api.mail.savedReplies.update, { replyId: id, name: 'Mine now' })
		).rejects.toThrow();
		await expect(t.mutation(api.mail.savedReplies.remove, { replyId: id })).rejects.toThrow();
		await expect(t.mutation(api.mail.savedReplies.recordUse, { replyId: id })).rejects.toThrow();

		as('user-A');
		await t.mutation(api.mail.savedReplies.update, { replyId: id, name: 'Refunds' });
		await t.mutation(api.mail.savedReplies.remove, { replyId: id });
		expect(await t.query(api.mail.savedReplies.listMine, {})).toEqual([]);
	});

	it('keep no image they have no bytes for, such as one pasted into the composer (#1293)', async () => {
		const t = await harness();
		await t.mutation(api.mail.savedReplies.create, {
			scope: 'personal',
			name: 'Logo',
			shortcut: '',
			bodyHtml:
				'<p>Our logo:</p><p><img data-inline-cid="logo@owlat" alt="logo.png"></p>' +
				'<img src="blob:https://app.owlat.example/1" alt="preview">' +
				'<img src="cid:part@other" alt="quoted">' +
				'<img src="https://cdn.owlat.example/banner.png" alt="banner">',
		});

		const [row] = await t.query(api.mail.savedReplies.listMine, {});
		expect(row?.bodyHtml).toBe(
			'<p>Our logo:</p><p></p><img src="https://cdn.owlat.example/banner.png" alt="banner" />'
		);
	});

	it('refuses an empty name and an over-long shortcut', async () => {
		const t = await harness();
		await expect(
			t.mutation(api.mail.savedReplies.create, {
				scope: 'personal',
				name: '  ',
				shortcut: '',
				bodyHtml: '<p>x</p>',
			})
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.savedReplies.create, {
				scope: 'personal',
				name: 'Long',
				shortcut: 'x'.repeat(33),
				bodyHtml: '<p>x</p>',
			})
		).rejects.toThrow();
	});
});

describe('shared saved replies', () => {
	it('are added and changed by admins and inserted by every member', async () => {
		const t = await harness();
		const shared = {
			scope: 'shared' as const,
			name: 'Opening hours',
			shortcut: 'hours',
			bodyHtml: '<p>We are open 9 to 5.</p>',
		};
		await expect(t.mutation(api.mail.savedReplies.create, shared)).rejects.toThrow();

		as('admin-1', 'admin');
		const id = await t.mutation(api.mail.savedReplies.create, shared);

		as('user-A');
		expect(names(await t.query(api.mail.savedReplies.listForComposer, {}))).toEqual([
			'Opening hours',
		]);
		const list = await t.query(api.mail.savedReplies.listShared, {});
		expect(list.canManage).toBe(false);
		expect(names(list.replies)).toEqual(['Opening hours']);
		await expect(
			t.mutation(api.mail.savedReplies.update, { replyId: id, name: 'Hours' })
		).rejects.toThrow();
		await expect(t.mutation(api.mail.savedReplies.remove, { replyId: id })).rejects.toThrow();

		await t.mutation(api.mail.savedReplies.recordUse, { replyId: id });
		await t.mutation(api.mail.savedReplies.recordUse, { replyId: id });
		const [counted] = await t.query(api.mail.savedReplies.listForComposer, {});
		expect(counted?.useCount).toBe(2);
		expect(counted?.lastUsedAt).toEqual(expect.any(Number));

		as('admin-2', 'owner');
		expect((await t.query(api.mail.savedReplies.listShared, {})).canManage).toBe(true);
		await t.mutation(api.mail.savedReplies.update, { replyId: id, name: 'Hours' });
		await t.mutation(api.mail.savedReplies.remove, { replyId: id });
		expect((await t.query(api.mail.savedReplies.listShared, {})).replies).toEqual([]);
	});

	it('limited to a team inbox show only in that inbox’s composer', async () => {
		const t = await harness();
		const support = await seedMailbox(t, 'admin-1', { scope: 'shared', members: ['user-A'] });
		const sales = await seedMailbox(t, 'admin-1', { scope: 'shared', members: ['user-A'] });
		const personal = await seedMailbox(t, 'user-A');

		as('admin-1', 'admin');
		await expect(
			t.mutation(api.mail.savedReplies.create, {
				scope: 'shared',
				name: 'Bad limit',
				shortcut: '',
				bodyHtml: '<p>x</p>',
				mailboxIds: [personal],
			})
		).rejects.toThrow();
		const id = await t.mutation(api.mail.savedReplies.create, {
			scope: 'shared',
			name: 'Support only',
			shortcut: 'support',
			bodyHtml: '<p>x</p>',
			mailboxIds: [support, support],
		});

		as('user-A');
		const composer = (mailboxId?: Id<'mailboxes'>) =>
			t.query(api.mail.savedReplies.listForComposer, mailboxId ? { mailboxId } : {});
		expect(names(await composer(support))).toEqual(['Support only']);
		expect(await composer(sales)).toEqual([]);
		expect(await composer(personal)).toEqual([]);
		expect(await composer()).toEqual([]);
		// Counting a use does not need to know which composer it went into.
		await t.mutation(api.mail.savedReplies.recordUse, { replyId: id });

		// A mailbox the caller cannot write in counts as no mailbox.
		as('user-C');
		expect(await composer(support)).toEqual([]);

		as('admin-1', 'admin');
		await t.mutation(api.mail.savedReplies.update, { replyId: id, mailboxIds: [] });
		as('user-C');
		expect(names(await composer())).toEqual(['Support only']);
	});

	it('list for a member only the shared ones they could insert', async () => {
		const t = await harness();
		const support = await seedMailbox(t, 'admin-1', { scope: 'shared', members: ['user-A'] });
		const hr = await seedMailbox(t, 'admin-1', { scope: 'shared' });
		as('admin-1', 'admin');
		const reply = (name: string, mailboxIds: Id<'mailboxes'>[]) =>
			t.mutation(api.mail.savedReplies.create, {
				scope: 'shared',
				name,
				shortcut: '',
				bodyHtml: '<p>x</p>',
				mailboxIds,
			});
		await reply('Everywhere', []);
		await reply('Support', [support]);
		await reply('HR', [hr]);
		await reply('Support or HR', [support, hr]);
		expect(names((await t.query(api.mail.savedReplies.listShared, {})).replies)).toEqual([
			'Everywhere',
			'HR',
			'Support',
			'Support or HR',
		]);

		as('user-A');
		expect(names((await t.query(api.mail.savedReplies.listShared, {})).replies)).toEqual([
			'Everywhere',
			'Support',
			'Support or HR',
		]);
		as('user-C');
		expect(names((await t.query(api.mail.savedReplies.listShared, {})).replies)).toEqual([
			'Everywhere',
		]);
	});

	it('stay editable when an inbox they are limited to is deleted', async () => {
		const t = await harness();
		const support = await seedMailbox(t, 'admin-1', { scope: 'shared' });
		const sales = await seedMailbox(t, 'admin-1', { scope: 'shared' });
		const gone = await seedMailbox(t, 'admin-1', { scope: 'shared' });
		as('admin-1', 'admin');
		const id = await t.mutation(api.mail.savedReplies.create, {
			scope: 'shared',
			name: 'Limited',
			shortcut: '',
			bodyHtml: '<p>x</p>',
			mailboxIds: [support, gone],
		});
		await t.run((ctx) => ctx.db.patch(gone, { status: 'deleted' }));

		// The editor sends back the restriction it was given, deleted inbox and all.
		await t.mutation(api.mail.savedReplies.update, {
			replyId: id,
			name: 'Still limited',
			mailboxIds: [support, gone],
		});
		const [row] = (await t.query(api.mail.savedReplies.listShared, {})).replies;
		expect(row?.name).toBe('Still limited');
		expect(row?.mailboxIds).toEqual([support]);

		// A deleted inbox the reply was not limited to is still refused.
		await t.run((ctx) => ctx.db.patch(sales, { status: 'deleted' }));
		await expect(
			t.mutation(api.mail.savedReplies.update, { replyId: id, mailboxIds: [support, sales] })
		).rejects.toThrow();
	});
});

describe('how many replies there can be', () => {
	it('refuses one more than the lists show, per person and per organization', async () => {
		const t = await harness();
		await t.run(async (ctx) => {
			for (let i = 0; i < 200; i++) {
				await ctx.db.insert('mailSnippets', {
					scope: 'personal',
					ownerUserId: 'user-A',
					name: `Mine ${i}`,
					shortcut: '',
					bodyHtml: '<p>x</p>',
					createdAt: i,
					updatedAt: i,
				});
				await ctx.db.insert('mailSnippets', {
					scope: 'shared',
					organizationId: 'org-1',
					name: `Ours ${i}`,
					shortcut: '',
					bodyHtml: '<p>x</p>',
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		const one = { name: 'One more', shortcut: '', bodyHtml: '<p>x</p>' };
		await expect(
			t.mutation(api.mail.savedReplies.create, { scope: 'personal', ...one })
		).rejects.toThrow(/at most 200/);
		as('admin-1', 'admin');
		await expect(
			t.mutation(api.mail.savedReplies.create, { scope: 'shared', ...one })
		).rejects.toThrow(/at most 200/);
		// Another person still has room.
		await t.mutation(api.mail.savedReplies.create, { scope: 'personal', ...one });
	});
});

describe('rows written before saved replies', () => {
	it('read as personal on a personal mailbox and as limited-shared on a team inbox', async () => {
		const t = await harness();
		const personal = await seedMailbox(t, 'user-A');
		const team = await seedMailbox(t, 'admin-1', { scope: 'shared', members: ['user-A'] });
		const seed = await seedMailbox(t, 'admin-1', { scope: 'seed' });
		const mine = await seedLegacy(t, personal, 'Mine');
		const teams = await seedLegacy(t, team, 'Teams');
		await seedLegacy(t, seed, 'Seed');

		expect(names(await t.query(api.mail.savedReplies.listMine, {}))).toEqual(['Mine']);
		expect(names(await t.query(api.mail.savedReplies.listForComposer, {}))).toEqual(['Mine']);
		expect(
			names(await t.query(api.mail.savedReplies.listForComposer, { mailboxId: team }))
		).toEqual(['Mine', 'Teams']);
		// The owner of the personal mailbox manages its rows; a team row needs an admin.
		await t.mutation(api.mail.savedReplies.update, { replyId: mine, name: 'Mine!' });
		await expect(
			t.mutation(api.mail.savedReplies.update, { replyId: teams, name: 'x' })
		).rejects.toThrow();

		as('admin-1', 'admin');
		const shared = await t.query(api.mail.savedReplies.listShared, {});
		expect(shared.replies.map((r) => [r.name, r.mailboxIds])).toEqual([['Teams', [team]]]);
		// Its first edit writes the scope it was read with.
		await t.mutation(api.mail.savedReplies.update, { replyId: teams, name: 'Team reply' });
		const row = await t.run((ctx) => ctx.db.get(teams));
		expect(row).toMatchObject({
			scope: 'shared',
			organizationId: 'org-1',
			mailboxIds: [team],
			mailboxId: team,
		});
	});

	it('keep the previous release’s snippet API to the new rules', async () => {
		const t = await harness();
		const team = await seedMailbox(t, 'admin-1', { scope: 'shared', members: ['user-A'] });
		const teams = await seedLegacy(t, team, 'Teams');

		await expect(
			t.mutation(api.mail.snippets.create, {
				mailboxId: team,
				name: 'Sneaky',
				shortcut: '',
				bodyHtml: '<p>x</p>',
			})
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.snippets.update, { snippetId: teams, name: 'x' })
		).rejects.toThrow();
		await expect(t.mutation(api.mail.snippets.remove, { snippetId: teams })).rejects.toThrow();
		expect(names(await t.query(api.mail.snippets.list, { mailboxId: team }))).toEqual(['Teams']);
	});
});

describe('feature floor', () => {
	it('works on a Team-inbox-only instance', async () => {
		const t = await harness(['inbox']);
		await t.mutation(api.mail.savedReplies.create, {
			scope: 'personal',
			name: 'Hello',
			shortcut: 'hi',
			bodyHtml: '<p>Hello</p>',
		});
		expect(names(await t.query(api.mail.savedReplies.listForComposer, {}))).toEqual(['Hello']);
	});

	it('is closed without any mail surface', async () => {
		const t = await harness([]);
		await expect(t.query(api.mail.savedReplies.listMine, {})).rejects.toThrow();
	});
});
