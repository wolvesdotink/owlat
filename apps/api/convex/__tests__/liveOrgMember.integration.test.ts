/**
 * One "live org member" rule across every membership-write surface.
 *
 * `lib/userProfiles.ts` refuses a user whose `userProfiles` row is missing or
 * soft-deleted (`deletedAt` set, kept until the retention cron runs). Before
 * the rule was shared, only team inboxes refused a soft-deleted user; chat rooms,
 * DMs and inbox thread assignment accepted them. Each surface keeps its own
 * error message.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import { enableFeatures } from './factories';
import { modules, seedMailbox } from '../mail/__tests__/helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		getUserIdFromSession: vi.fn(async () => sessionMock.userId),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn(async () => true),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role === 'editor') throw new Error('forbidden');
			return session();
		}),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: string, message?: string) => {
			// Explicitly typed: TS only allows an assertion function called through
			// a declared-type binding.
			const mod: typeof SessionOrganization = actual;
			mod.requirePermission(
				mod.hasPermission(sessionMock.role, permission as Parameters<typeof mod.hasPermission>[1]),
				message
			);
			return session();
		}),
	};
});

beforeEach(() => {
	sessionMock.userId = 'admin-user';
	sessionMock.role = 'admin';
});

/** Seed profiles: `live-user` and the actor are live, `gone-user` is soft-deleted. */
async function seedProfiles(t: TestConvex<typeof schema>): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const authUserId of ['admin-user', 'live-user', 'gone-user']) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@owlat.test`,
				name: authUserId,
				...(authUserId === 'gone-user' ? { deletedAt: now, deletedBy: authUserId } : {}),
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe('team inbox addMember', () => {
	it('refuses a soft-deleted user and accepts a live one', async () => {
		const t = convexTest(schema, modules);
		await seedProfiles(t);
		const mailboxId = await seedMailbox(t, {
			userId: 'admin-user',
			scope: 'shared',
			kind: 'external',
			address: 'team@owlat.test',
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: 'admin-user',
				role: 'owner',
				addedBy: 'admin-user',
				createdAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.mail.mailboxMembers.addMember, { mailboxId, authUserId: 'gone-user' })
		).rejects.toThrow('That person is not a member of your organization.');

		const res = await t.mutation(api.mail.mailboxMembers.addMember, {
			mailboxId,
			authUserId: 'live-user',
		});
		expect(res.alreadyMember).toBe(false);
		const memberIds = await t.run(async (ctx) =>
			(
				await ctx.db
					.query('mailboxMembers')
					.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailboxId))
					.collect()
			).map((row) => row.authUserId)
		);
		expect(memberIds.sort()).toEqual(['admin-user', 'live-user']);
	});
});

describe('chat membership writes', () => {
	const notMember = 'One or more selected people are not members of this organization';

	it('refuses a soft-deleted user in a DM and accepts a live one', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedProfiles(t);

		await expect(
			t.mutation(api.chat.dms.findOrCreateDm, { otherMemberIds: ['gone-user'] })
		).rejects.toThrow(notMember);
		await expect(
			t.mutation(api.chat.dms.findOrCreateDm, { otherMemberIds: ['live-user'] })
		).resolves.toBeTruthy();
	});

	it('refuses a soft-deleted user as a channel seed member or added member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedProfiles(t);

		await expect(
			t.mutation(api.chat.rooms.createChannel, {
				name: 'ops',
				visibility: 'public',
				initialMemberIds: ['live-user', 'gone-user'],
			})
		).rejects.toThrow(notMember);

		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'ops',
			visibility: 'public',
			initialMemberIds: ['live-user'],
		});
		await expect(
			t.mutation(api.chat.members.addMember, { roomId, memberId: 'gone-user' })
		).rejects.toThrow(notMember);
	});

	it('still caps the batch size', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedProfiles(t);
		const ids = Array.from({ length: 51 }, (_, i) => `user-${i}`);
		await expect(t.mutation(api.chat.dms.findOrCreateDm, { otherMemberIds: ids })).rejects.toThrow(
			'Cannot add more than 50 people at once'
		);
	});
});

describe('inbox assignThread', () => {
	async function seedThread(t: TestConvex<typeof schema>): Promise<Id<'conversationThreads'>> {
		return t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert('conversationThreads', {
				subject: 'ticket',
				normalizedSubject: 'ticket',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
		});
	}

	it('refuses a soft-deleted assignee and sends them no notice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await seedProfiles(t);
		const threadId = await seedThread(t);

		await expect(
			t.mutation(api.inbox.mutations.assignThread, { threadId, assignedTo: 'gone-user' })
		).rejects.toThrow('Cannot assign a thread to a non-member');

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBeUndefined();
		const notices = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
		expect(notices).toHaveLength(0);
	});

	it('assigns a live member and names the actor in their notice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await seedProfiles(t);
		const threadId = await seedThread(t);

		await t.mutation(api.inbox.mutations.assignThread, { threadId, assignedTo: 'live-user' });

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBe('live-user');
		const notices = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
		expect(notices.map((n) => [n.userId, n.assignedByName])).toEqual([['live-user', 'admin-user']]);
	});
});
