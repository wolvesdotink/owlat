/**
 * Shared-mailbox membership — authz matrix + backfill.
 *
 * Covers the membership extension to the mailbox choke point
 * (`mail/permissions.ts::requireMailboxAccess`) and the idempotent owner-row
 * backfill (`migrations/0034_mailbox_owner_membership`).
 *
 * The matrix asserts owner / member / non-member callers against the
 * member-level and owner-level access floors on BOTH a personal and a shared
 * mailbox. Personal-mailbox behaviour is bit-for-bit unchanged — covered here
 * for the shared case and in `permissions.test.ts` for the personal case.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { requireMailboxAccess } from '../permissions';
import { provisionMailbox } from '../mailbox';
import { modules, seedMailbox } from './helpers';

// One mutable hoisted session drives BOTH the `authedMutation`/`authedQuery`
// wrapper floors (`getMutationContext` / `requireOrgMember`) AND the in-handler
// mailbox gate (`getBetterAuthSessionWithRole`). Mocking only the latter would
// leave the wrapper floor calling the real `requireOrgMember`, which throws an
// unauthenticated error before the owner-floor gate ever runs — making the
// endpoint-level owner-floor evidence vacuous. `setSession` flips all three.
const sessionMock = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner' as 'owner' | 'admin' | 'editor' | null,
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
			return { userId: sessionMock.userId, role: sessionMock.role };
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

async function addMember(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	authUserId: string,
	role: 'owner' | 'member'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId,
			role,
			addedBy: 'admin-user',
			createdAt: Date.now(),
		});
	});
}

describe('requireMailboxAccess — shared mailbox membership matrix', () => {
	// A shared mailbox provisioned by user-A, with user-B as a plain member and
	// user-C as a member with owner role. user-D belongs to nothing.
	async function seedShared(t: ReturnType<typeof convexTest>): Promise<Id<'mailboxes'>> {
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'shared' });
		await addMember(t, id, 'user-A', 'owner');
		await addMember(t, id, 'user-B', 'member');
		await addMember(t, id, 'user-C', 'owner');
		return id;
	}

	it('grants a plain member read/use access (minRole member)', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id));
		if (!result.ok) throw new Error('expected member to be granted');
		expect(result.userId).toBe('user-B');
	});

	it('denies a plain member owner-level access (minRole owner)', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('grants an owner-role member both member and owner access', async () => {
		setSession('user-C', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const asMember = await t.run((ctx) => requireMailboxAccess(ctx, id, 'member'));
		const asOwner = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		expect(asMember.ok).toBe(true);
		expect(asOwner.ok).toBe(true);
	});

	it('denies a non-member editor', async () => {
		setSession('user-D', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('still lets org owner act on a shared mailbox at owner level', async () => {
		setSession('user-D', 'owner');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		if (!result.ok) throw new Error('expected org owner to be granted');
		expect(result.userId).toBe('user-D');
	});

	it('the provisioning user keeps owner-level access to their shared mailbox', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		expect(result.ok).toBe(true);
	});

	it('denies a member whose session active org differs from the mailbox org', async () => {
		// Defense-in-depth: a membership row can only grant inside the caller's
		// active org, so a stale row can't cross an org boundary.
		setSession('user-B', 'editor', 'org-OTHER');
		const t = convexTest(schema, modules);
		const id = await seedShared(t); // mailbox is in org-1
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});
});

// The helper's owner/member floors are only load-bearing if the real endpoints
// pass the right `minRole`. These drive two owner-grade operations end-to-end
// and assert a plain shared-mailbox member is refused while an owner-role
// member is allowed.
describe('owner-grade endpoints enforce the owner floor for shared-mailbox members', () => {
	async function seedSharedTeamMailbox(t: ReturnType<typeof convexTest>): Promise<Id<'mailboxes'>> {
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'shared' });
		await addMember(t, id, 'user-A', 'owner');
		await addMember(t, id, 'user-B', 'member'); // plain member
		await addMember(t, id, 'user-C', 'owner'); // owner-role member
		return id;
	}

	it('appPasswords.generate refuses a plain member', async () => {
		const t = convexTest(schema, modules);
		const id = await seedSharedTeamMailbox(t);
		setSession('user-B', 'editor');
		await expect(
			t.mutation(api.mail.appPasswords.generate, { mailboxId: id, label: 'imap' })
		).rejects.toThrow('Mailbox not accessible');
	});

	it('aliases.create refuses a plain member', async () => {
		const t = convexTest(schema, modules);
		const id = await seedSharedTeamMailbox(t);
		setSession('user-B', 'editor');
		await expect(
			t.mutation(api.mail.aliases.create, { mailboxId: id, alias: 'sales@hinterland.camp' })
		).rejects.toThrow('Mailbox not accessible');
	});

	it('aliases.create is allowed for an owner-role member', async () => {
		const t = convexTest(schema, modules);
		const id = await seedSharedTeamMailbox(t);
		setSession('user-C', 'editor');
		await t.mutation(api.mail.aliases.create, { mailboxId: id, alias: 'sales@hinterland.camp' });
		const aliases = await t.run((ctx) =>
			ctx.db
				.query('mailAliases')
				.withIndex('by_target', (q) => q.eq('targetMailboxId', id))
				.collect()
		);
		expect(aliases.map((a) => a.alias)).toContain('sales@hinterland.camp');
	});
});

describe('requireMailboxAccess — personal mailbox behaviour is unchanged', () => {
	it('a non-owner editor with no membership is forbidden at member level', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'personal' });
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('the owner keeps owner-level access with no membership row present', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'personal' });
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		if (!result.ok) throw new Error('expected owner to be granted');
		expect(result.userId).toBe('user-A');
	});
});

describe('provisionMailbox — writes the implicit owner membership row', () => {
	it('a freshly provisioned mailbox carries exactly one owner row for its user', async () => {
		const t = convexTest(schema, modules);
		const id = await t.run((ctx) =>
			provisionMailbox(ctx, {
				userId: 'user-A',
				organizationId: 'org-1',
				address: 'fresh@hinterland.camp',
				domain: 'hinterland.camp',
			})
		);

		const rows = await t.run((ctx) =>
			ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', id).eq('authUserId', 'user-A'))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe('owner');
		expect(rows[0]?.addedBy).toBe('user-A');
	});

	it('the owner-row invariant makes the backfill a no-op for provisioned mailboxes', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			provisionMailbox(ctx, {
				userId: 'user-A',
				organizationId: 'org-1',
				address: 'fresh@hinterland.camp',
				domain: 'hinterland.camp',
			})
		);
		const result = await t.mutation(internal.migrations['0034_mailbox_owner_membership'].run, {});
		expect(result.created).toBe(0);
	});
});

describe('migrations/0034 — implicit owner backfill', () => {
	it('creates one owner membership per existing mailbox and is idempotent', async () => {
		const t = convexTest(schema, modules);
		const idA = await seedMailbox(t, { userId: 'user-A', address: 'a@hinterland.camp' });
		const idB = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });

		const first = await t.mutation(internal.migrations['0034_mailbox_owner_membership'].run, {});
		expect(first.created).toBe(2);

		const rows = await t.run((ctx) => ctx.db.query('mailboxMembers').collect());
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.role).toBe('owner');
		}
		const owners = new Map(rows.map((r) => [r.mailboxId, r.authUserId]));
		expect(owners.get(idA)).toBe('user-A');
		expect(owners.get(idB)).toBe('user-B');

		// Re-running is a no-op.
		const second = await t.mutation(internal.migrations['0034_mailbox_owner_membership'].run, {});
		expect(second.created).toBe(0);
		const after = await t.run((ctx) => ctx.db.query('mailboxMembers').collect());
		expect(after).toHaveLength(2);
	});

	it('backfilled owner grants the owner access via requireMailboxAccess', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		await t.mutation(internal.migrations['0034_mailbox_owner_membership'].run, {});

		setSession('user-A', 'editor');
		const result = await t.run((ctx) => requireMailboxAccess(ctx, id, 'owner'));
		expect(result.ok).toBe(true);
	});
});
