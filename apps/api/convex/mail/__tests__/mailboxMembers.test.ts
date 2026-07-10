/**
 * Team (shared) inbox creation + membership management.
 *
 * Covers `mail/mailboxMembers.ts`: creating a shared inbox (hosted create flow
 * + an externally-backed shared mailbox), the member roster read, and the
 * add / remove / transfer-ownership mutations — including the load-bearing
 * guarantee that a removed member loses access on the next reactive tick.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers';

// One mutable hoisted session drives both the wrapper floors
// (`getMutationContext` / `requireOrgMember`) and the in-handler mailbox gate
// (`getBetterAuthSessionWithRole`). See mailboxAccess.test.ts for the rationale.
const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		// `requireAdminContext` normally chains through `getMutationContext` →
		// `requireOrgMember` → real BetterAuth, which the exported mocks above don't
		// intercept (same-module bindings). Mock it directly so the admin gate
		// reflects `sessionMock.role`.
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	sessionMock.userId = userId;
	sessionMock.role = role;
	sessionMock.orgId = orgId;
}

/** All membership rows on a mailbox, keyed by member id → role. */
async function roles(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<Map<string, 'owner' | 'member'>> {
	const rows = await t.run((ctx) =>
		ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
	return new Map(rows.map((r) => [r.authUserId, r.role]));
}

/**
 * Seed `userProfiles` rows for the given auth-user ids — the server-side
 * org-membership floor (`assertOrgMemberUser`) requires a live profile before a
 * user can be added to / made owner of a shared inbox.
 */
async function seedUsers(t: TestConvex<typeof schema>, ...authUserIds: string[]): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const authUserId of authUserIds) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@hinterland.camp`,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/**
 * Seed a `verified` sending domain — `createShared` requires the team-inbox
 * address to sit on one (the server-side mirror of the UI's `listVerified`
 * restriction).
 */
async function seedVerifiedDomain(
	t: TestConvex<typeof schema>,
	domain = 'hinterland.camp'
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('domains', {
			domain,
			status: 'verified',
			dnsRecords: {},
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** Seed a shared, externally-backed team inbox with its owner membership row. */
async function seedSharedExternal(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	const id = await seedMailbox(t, {
		userId: 'admin-user',
		scope: 'shared',
		kind: 'external',
		address: 'team-ext@hinterland.camp',
	});
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxMembers', {
			mailboxId: id,
			authUserId: 'admin-user',
			role: 'owner',
			addedBy: 'admin-user',
			createdAt: Date.now(),
		});
	});
	return id;
}

describe('createShared — hosted team inbox', () => {
	it('provisions a shared mailbox with the creator as owner and the initial members', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await seedUsers(t, 'user-B', 'user-C');
		const id = await t.mutation(api.mail.mailboxMembers.createShared, {
			address: 'Sales <sales@hinterland.camp>',
			displayName: 'Sales',
			memberUserIds: ['user-B', 'user-C', 'user-B'], // dup is deduped
		});

		const mailbox = await t.run((ctx) => ctx.db.get(id));
		expect(mailbox?.scope).toBe('shared');
		expect(mailbox?.address).toBe('sales@hinterland.camp');
		expect(mailbox?.userId).toBe('admin-user');

		const map = await roles(t, id);
		expect(map.get('admin-user')).toBe('owner');
		expect(map.get('user-B')).toBe('member');
		expect(map.get('user-C')).toBe('member');
		expect(map.size).toBe(3);
	});

	it('rejects a non-admin creator with a permission error', async () => {
		const t = convexTest(schema, modules);
		setSession('editor-user', 'editor');
		await expect(
			t.mutation(api.mail.mailboxMembers.createShared, {
				address: 'sales@hinterland.camp',
				memberUserIds: [],
			})
		).rejects.toThrow(/owners and admins/i);
	});

	it('rejects an address on an unverified domain', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await expect(
			t.mutation(api.mail.mailboxMembers.createShared, {
				address: 'sales@not-verified.example',
				memberUserIds: [],
			})
		).rejects.toThrow(/verified/i);
	});

	it('rejects an initial member who is not an org member', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await expect(
			t.mutation(api.mail.mailboxMembers.createShared, {
				address: 'sales@hinterland.camp',
				memberUserIds: ['ghost-user'],
			})
		).rejects.toThrow(/not a member/i);
	});

	it('rejects a duplicate address', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await seedMailbox(t, { address: 'taken@hinterland.camp' });
		await expect(
			t.mutation(api.mail.mailboxMembers.createShared, {
				address: 'taken@hinterland.camp',
				memberUserIds: [],
			})
		).rejects.toThrow('already exists');
	});
});

describe('members roster', () => {
	it('lists members for a member and hides the roster from a non-member', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await seedUsers(t, 'user-B');
		const id = await t.mutation(api.mail.mailboxMembers.createShared, {
			address: 'support@hinterland.camp',
			memberUserIds: ['user-B'],
		});

		// The member sees the roster.
		setSession('user-B', 'editor');
		const seen = await t.query(api.mail.mailboxMembers.members, { mailboxId: id });
		expect(seen.map((m) => m.authUserId).sort()).toEqual(['admin-user', 'user-B']);

		// A non-member editor sees nothing (soft-fail, no thrown error).
		setSession('user-Z', 'editor');
		const hidden = await t.query(api.mail.mailboxMembers.members, { mailboxId: id });
		expect(hidden).toEqual([]);
	});
});

describe('addMember / removeMember', () => {
	it('adds a member (idempotently) and grants them access', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const id = await seedSharedExternal(t);
		await seedUsers(t, 'user-B');

		await t.mutation(api.mail.mailboxMembers.addMember, { mailboxId: id, authUserId: 'user-B' });
		const again = await t.mutation(api.mail.mailboxMembers.addMember, {
			mailboxId: id,
			authUserId: 'user-B',
		});
		expect(again.alreadyMember).toBe(true);
		expect((await roles(t, id)).get('user-B')).toBe('member');

		// The new member now has access to the (external) shared mailbox.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId: id })).toBe('member');
		expect(await t.query(api.mail.mailbox.get, { mailboxId: id })).not.toBeNull();
	});

	it('a plain member cannot manage the roster (owner floor)', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const id = await seedSharedExternal(t);
		await seedUsers(t, 'user-B');
		await t.mutation(api.mail.mailboxMembers.addMember, { mailboxId: id, authUserId: 'user-B' });

		setSession('user-B', 'editor');
		await expect(
			t.mutation(api.mail.mailboxMembers.addMember, { mailboxId: id, authUserId: 'user-C' })
		).rejects.toThrow('permission');
	});

	it('removing a member revokes access immediately — their reactive queries return nothing', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await seedUsers(t, 'user-B');
		const id = await t.mutation(api.mail.mailboxMembers.createShared, {
			address: 'ops@hinterland.camp',
			memberUserIds: ['user-B'],
		});

		// Before removal: user-B has access.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId: id })).toBe('member');

		// Admin removes them.
		setSession('admin-user', 'admin');
		await t.mutation(api.mail.mailboxMembers.removeMember, { mailboxId: id, authUserId: 'user-B' });

		// After removal: every access query user-B watches returns nothing.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId: id })).toBeNull();
		expect(await t.query(api.mail.mailboxMembers.members, { mailboxId: id })).toEqual([]);
		expect(await t.query(api.mail.mailbox.get, { mailboxId: id })).toBeNull();
		const list = await t.query(api.mail.mailbox.list, {});
		expect(list.map((m) => m._id)).not.toContain(id);
	});

	it("refuses to remove the mailbox's canonical owner (transfer ownership first)", async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const id = await seedSharedExternal(t);
		await expect(
			t.mutation(api.mail.mailboxMembers.removeMember, {
				mailboxId: id,
				authUserId: 'admin-user',
			})
		).rejects.toThrow('Transfer inbox ownership');
	});
});

describe('transferOwnership', () => {
	it('promotes the new owner, updates the canonical userId, and demotes the old owner', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedVerifiedDomain(t);
		await seedUsers(t, 'user-B');
		const id = await t.mutation(api.mail.mailboxMembers.createShared, {
			address: 'billing@hinterland.camp',
			memberUserIds: ['user-B'],
		});

		await t.mutation(api.mail.mailboxMembers.transferOwnership, {
			mailboxId: id,
			authUserId: 'user-B',
		});

		const mailbox = await t.run((ctx) => ctx.db.get(id));
		expect(mailbox?.userId).toBe('user-B');
		const map = await roles(t, id);
		expect(map.get('user-B')).toBe('owner');
		expect(map.get('admin-user')).toBe('member');

		// The new owner can now manage the roster; the previous owner retains access.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId: id })).toBe('owner');
		setSession('admin-user', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId: id })).toBe('member');
	});
});
