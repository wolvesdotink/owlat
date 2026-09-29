/**
 * The two mailbox listings: `identity.list` (the caller's own mailboxes, for
 * everyone, admins included) and `identity.listOrgMailboxes` (the admin-only
 * org-wide list behind the Preferences rename/delete screen).
 *
 * Regression: `identity.list` used to hand owners and admins every active or
 * suspended mailbox in the deployment, seeds included. Postbox and quick-create
 * take `list[0]` when there is no stored selection, so an admin on a new device
 * could open a teammate's personal inbox or their own deliverability seed.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.orgId,
	});
	return {
		...actual,
		// The `adminQuery` floor calls this through a same-module binding, so it
		// is mocked directly rather than through `getBetterAuthSessionWithRole`.
		requireOrgPermission: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error("You don't have permission to perform this action");
			}
			return session();
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => (sessionMock.role === null ? null : session())),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null): void {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

async function addMember(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	authUserId: string
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId,
			role: 'member',
			addedBy: 'admin-user',
			createdAt: Date.now(),
		});
	});
}

/**
 * The admin's own mailbox, their own seed, a teammate's personal inbox, a team
 * inbox the admin belongs to, a suspended own mailbox, a deleted one and a
 * mailbox in another organization.
 */
async function seedOrg(t: TestConvex<typeof schema>) {
	const own = await seedMailbox(t, { userId: 'admin-user', address: 'admin@owlat.test' });
	const seed = await seedMailbox(t, {
		userId: 'admin-user',
		address: 'seed@gmail.example',
		kind: 'external',
	});
	await t.run((ctx) => ctx.db.patch(seed, { scope: 'seed' }));
	const teammate = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
	const team = await seedMailbox(t, {
		userId: 'user-B',
		address: 'support@owlat.test',
		scope: 'shared',
	});
	await addMember(t, team, 'admin-user');
	const suspended = await seedMailbox(t, {
		userId: 'admin-user',
		address: 'old@owlat.test',
		status: 'suspended',
	});
	const deleted = await seedMailbox(t, {
		userId: 'user-B',
		address: 'gone@owlat.test',
		status: 'deleted',
	});
	const otherOrg = await seedMailbox(t, {
		userId: 'user-C',
		organizationId: 'org-2',
		address: 'c@elsewhere.test',
	});
	return { own, seed, teammate, team, suspended, deleted, otherOrg };
}

describe('identity.list', () => {
	it("gives an admin only their own and member mailboxes, never a teammate's inbox or a seed", async () => {
		const t = convexTest(schema, modules);
		const ids = await seedOrg(t);
		setSession('admin-user', 'admin');

		const list = await t.query(api.mail.mailbox.identity.list, {});
		expect(new Set(list.map((m) => m._id))).toEqual(new Set([ids.own, ids.team, ids.suspended]));
		// The default Postbox/quick-create mailbox is the caller's own.
		expect(list[0]?._id).toBe(ids.own);
	});

	it('gives an owner the same own-plus-membership set', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedOrg(t);
		setSession('admin-user', 'owner');

		const list = await t.query(api.mail.mailbox.identity.list, {});
		expect(list.map((m) => m._id)).not.toContain(ids.teammate);
		expect(list.map((m) => m._id)).not.toContain(ids.seed);
	});

	it('puts a live mailbox ahead of an older suspended one, so the default is usable', async () => {
		const t = convexTest(schema, modules);
		const paused = await seedMailbox(t, {
			userId: 'user-B',
			address: 'paused@owlat.test',
			status: 'suspended',
		});
		const live = await seedMailbox(t, { userId: 'user-B', address: 'live@owlat.test' });
		setSession('user-B', 'editor');

		const list = await t.query(api.mail.mailbox.identity.list, {});
		expect(list.map((m) => m._id)).toEqual([live, paused]);
	});

	it('returns nothing when the instance has no personal mail', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, { userId: 'admin-user', featuresOff: true });
		setSession('admin-user', 'admin');

		expect(await t.query(api.mail.mailbox.identity.list, {})).toEqual([]);
		expect(await t.query(api.mail.mailbox.identity.listOrgMailboxes, {})).toEqual([]);
	});

	it('returns nothing for an anonymous caller', async () => {
		const t = convexTest(schema, modules);
		await seedOrg(t);
		setSession('admin-user', null);

		expect(await t.query(api.mail.mailbox.identity.list, {})).toEqual([]);
	});
});

describe('identity.listOrgMailboxes', () => {
	it('refuses an editor', async () => {
		const t = convexTest(schema, modules);
		await seedOrg(t);
		setSession('user-B', 'editor');

		await expect(t.query(api.mail.mailbox.identity.listOrgMailboxes, {})).rejects.toThrow(
			'permission'
		);
	});

	it("returns the admin's organization's active and suspended mailboxes without seeds", async () => {
		const t = convexTest(schema, modules);
		const ids = await seedOrg(t);
		setSession('admin-user', 'admin');

		const list = await t.query(api.mail.mailbox.identity.listOrgMailboxes, {});
		expect(new Set(list.map((m) => m._id))).toEqual(
			new Set([ids.own, ids.teammate, ids.team, ids.suspended])
		);
	});
});
