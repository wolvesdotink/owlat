/**
 * Shared-mailbox membership — authz matrix + backfill.
 *
 * Covers the membership extension to the mailbox choke point
 * (`mail/permissions.ts::loadOwnedMailbox`) and the idempotent owner-row
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
import { internal } from '../../_generated/api';
import { loadOwnedMailbox } from '../permissions';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
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

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	if (role === null) {
		sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(null);
		return;
	}
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role,
		activeOrganizationId: orgId,
	});
}

async function seedMailbox(
	t: ReturnType<typeof convexTest>,
	opts: { userId: string; scope?: 'personal' | 'shared'; address?: string }
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId: opts.userId,
			organizationId: 'org-1',
			address: opts.address ?? 'team@hinterland.camp',
			domain: 'hinterland.camp',
			...(opts.scope ? { scope: opts.scope } : {}),
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
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

describe('loadOwnedMailbox — shared mailbox membership matrix', () => {
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
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		if (!result.ok) throw new Error('expected member to be granted');
		expect(result.userId).toBe('user-B');
	});

	it('denies a plain member owner-level access (minRole owner)', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('grants an owner-role member both member and owner access', async () => {
		setSession('user-C', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const asMember = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'member'));
		const asOwner = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		expect(asMember.ok).toBe(true);
		expect(asOwner.ok).toBe(true);
	});

	it('denies a non-member editor', async () => {
		setSession('user-D', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('still lets org owner act on a shared mailbox at owner level', async () => {
		setSession('user-D', 'owner');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		if (!result.ok) throw new Error('expected org owner to be granted');
		expect(result.userId).toBe('user-D');
	});

	it('the provisioning user keeps owner-level access to their shared mailbox', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedShared(t);
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		expect(result.ok).toBe(true);
	});
});

describe('loadOwnedMailbox — personal mailbox behaviour is unchanged', () => {
	it('a non-owner editor with no membership is forbidden at member level', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'personal' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('the owner keeps owner-level access with no membership row present', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', scope: 'personal' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		if (!result.ok) throw new Error('expected owner to be granted');
		expect(result.userId).toBe('user-A');
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

	it('backfilled owner grants the owner access via loadOwnedMailbox', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		await t.mutation(internal.migrations['0034_mailbox_owner_membership'].run, {});

		setSession('user-A', 'editor');
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id, 'owner'));
		expect(result.ok).toBe(true);
	});
});
