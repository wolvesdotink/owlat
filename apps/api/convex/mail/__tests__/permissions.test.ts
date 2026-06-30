/**
 * Mailbox gate (helper) — outcome coverage.
 *
 * Replaces the eleven copies of `loadOwnedMailbox` that used to live in
 * each `mail/*.ts` file. The four `reason` branches plus the three
 * owner/admin/same-user paths into `{ ok: true, ... }` are all asserted
 * here so per-file tests no longer need to repeat them.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { loadOwnedMailbox, loadReadableMailbox } from '../permissions';

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
		.filter(([path]) =>
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
		// Sibling `mail/*` modules glob in as `../foo.ts` (this file lives in
		// `mail/__tests__/`); convex-test resolves function paths from the
		// convex root, so re-root them to `../../mail/foo.ts` — otherwise
		// `t.query(api.mail.mailbox.get)` can't find the module.
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

type MailboxSeed = {
	userId?: string;
	organizationId?: string;
	address?: string;
	status?: 'active' | 'suspended' | 'deleted';
};

async function seedMailbox(
	t: ReturnType<typeof convexTest>,
	seed: MailboxSeed = {}
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId: seed.userId ?? 'user-A',
			organizationId: seed.organizationId ?? 'org-1',
			address: seed.address ?? 'a@hinterland.camp',
			domain: 'hinterland.camp',
			status: seed.status ?? 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

function setSession(
	userId: string,
	role: 'owner' | 'admin' | 'editor' | null,
	orgId = 'org-1'
) {
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

describe('loadOwnedMailbox', () => {
	it('returns no_session when no BetterAuth session is present', async () => {
		setSession('', null);
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t);
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'no_session' });
	});

	it('returns mailbox_missing when the id resolves to no row', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		// seed something so the table exists, then ask for a different id
		const realId = await seedMailbox(t);
		const fakeId = ('fake-' + realId) as unknown as Id<'mailboxes'>;
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, fakeId));
		expect(result).toEqual({ ok: false, reason: 'mailbox_missing' });
	});

	it('returns mailbox_inactive when status is suspended', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'suspended' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'mailbox_inactive' });
	});

	it('returns mailbox_inactive when status is deleted', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'deleted' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'mailbox_inactive' });
	});

	it('returns forbidden when caller is editor and not the mailbox owner', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		expect(result).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('grants ok when caller is owner of the mailbox', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		if (!result.ok) throw new Error('expected ok');
		expect(result.userId).toBe('user-A');
		expect(result.mailbox.address).toBe('a@hinterland.camp');
		expect(result.mailbox._id).toBe(id);
	});

	it('grants ok when role=owner acts on another user’s mailbox', async () => {
		setSession('user-B', 'owner');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		if (!result.ok) throw new Error('expected ok');
		expect(result.userId).toBe('user-B');
		expect(result.mailbox.userId).toBe('user-A');
	});

	it('grants ok when role=admin acts on another user’s mailbox', async () => {
		setSession('user-B', 'admin');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadOwnedMailbox(ctx, id));
		if (!result.ok) throw new Error('expected ok');
		expect(result.userId).toBe('user-B');
	});
});

describe('loadReadableMailbox (read-side counterpart)', () => {
	it('returns null for an anonymous caller', async () => {
		setSession('', null);
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t);
		const result = await t.run((ctx) => loadReadableMailbox(ctx, id));
		expect(result).toBeNull();
	});

	it('returns null when a non-owner editor reads another user’s mailbox', async () => {
		setSession('user-B', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadReadableMailbox(ctx, id));
		expect(result).toBeNull();
	});

	it('returns null for a suspended mailbox even to its owner', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'suspended' });
		const result = await t.run((ctx) => loadReadableMailbox(ctx, id));
		expect(result).toBeNull();
	});

	it('returns null for a deleted mailbox even to its owner', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'deleted' });
		const result = await t.run((ctx) => loadReadableMailbox(ctx, id));
		expect(result).toBeNull();
	});

	it('returns the row to its owner on an active mailbox', async () => {
		setSession('user-A', 'editor');
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.run((ctx) => loadReadableMailbox(ctx, id));
		expect(result?._id).toBe(id);
		expect(result?.userId).toBe('user-A');
	});
});

/** Seed the inbox system folder a mailbox provisions, for listFolders reads. */
async function seedInboxFolder(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('mailbox read handlers route through loadReadableMailbox', () => {
	it('mailbox.get returns the row to the owner but null to a non-owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });

		setSession('user-A', 'editor');
		const owned = await t.query(api.mail.mailbox.get, { mailboxId: id });
		expect(owned?._id).toBe(id);

		// A different non-privileged user must not be able to read it by id.
		setSession('user-B', 'editor');
		const foreign = await t.query(api.mail.mailbox.get, { mailboxId: id });
		expect(foreign).toBeNull();
	});

	it('mailbox.get returns null on a soft-deleted mailbox even to its owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'deleted' });
		setSession('user-A', 'editor');
		const result = await t.query(api.mail.mailbox.get, { mailboxId: id });
		expect(result).toBeNull();
	});

	it('mailbox.listMessages returns the empty sentinel to a non-owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		setSession('user-B', 'editor');
		const result = await t.query(api.mail.mailbox.listMessages, { mailboxId: id });
		expect(result).toEqual({ messages: [], hasMore: false });
	});

	it('mailbox.listMessages returns the empty sentinel on a suspended mailbox to its owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'suspended' });
		setSession('user-A', 'editor');
		const result = await t.query(api.mail.mailbox.listMessages, { mailboxId: id });
		expect(result).toEqual({ messages: [], hasMore: false });
	});

	it('mailbox.listFolders lists folders for the owner but is empty for a non-owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A' });
		await seedInboxFolder(t, id);

		setSession('user-A', 'editor');
		const owned = await t.query(api.mail.mailbox.listFolders, { mailboxId: id });
		expect(owned).toHaveLength(1);
		expect(owned[0]?.role).toBe('inbox');

		setSession('user-B', 'editor');
		const foreign = await t.query(api.mail.mailbox.listFolders, { mailboxId: id });
		expect(foreign).toEqual([]);
	});

	it('mailbox.listFolders is empty on a deleted mailbox even to its owner', async () => {
		const t = convexTest(schema, modules);
		const id = await seedMailbox(t, { userId: 'user-A', status: 'deleted' });
		await seedInboxFolder(t, id);
		setSession('user-A', 'editor');
		const result = await t.query(api.mail.mailbox.listFolders, { mailboxId: id });
		expect(result).toEqual([]);
	});
});
