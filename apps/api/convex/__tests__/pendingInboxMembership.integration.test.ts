/**
 * Coverage for the team-inbox membership grant flow in mail/pendingMailbox.ts:
 *   - reserveInboxMembership -> claimInboxMemberships: membership materializes
 *   - grant is bound to the invitee email (a different-email accept can't claim)
 *   - reservation + claim are both idempotent
 *
 * Implements the e5 "invite someone straight into a team inbox" piece of the
 * 2026-07-10 experience plan (LOCKED decision 7: team inboxes are shared Postbox
 * mailboxes; membership is explicit).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMocks = vi.hoisted(() => ({
	getMutationContext: vi.fn(),
	getBetterAuthSessionWithRole: vi.fn(),
	requireAdminContext: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: sessionMocks.getMutationContext,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireAdminContext: sessionMocks.requireAdminContext,
	};
});

function setAdminSession(userId = 'admin-user', orgId = 'test-org') {
	sessionMocks.getMutationContext.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'owner',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireAdminContext.mockResolvedValue({ userId, role: 'owner' });
}

function setInviteeSession(userId: string, orgId = 'test-org') {
	sessionMocks.getMutationContext.mockResolvedValue({ userId, role: 'editor' });
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'editor',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireAdminContext.mockImplementation(async () => {
		throw new Error('Only owners and admins can perform this action');
	});
}

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

async function seedSharedMailbox(
	t: ReturnType<typeof convexTest>,
	address: string,
	orgId = 'test-org'
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId: 'admin-user',
			organizationId: orgId,
			address,
			domain: address.split('@')[1] ?? '',
			scope: 'shared',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

async function seedUserProfile(
	t: ReturnType<typeof convexTest>,
	userId: string,
	email: string
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('pendingMailbox.reserveInboxMembership', () => {
	it('reserves a grant on a team inbox for a not-yet-member email', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');

		const result = await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'Newbie@Example.com',
		});
		expect(result.address).toBe('support@hinterland.camp');
		expect(result.alreadyReserved).toBe(false);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('pendingMailboxMembers').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.inviteeEmail).toBe('newbie@example.com'); // canonical lowercase
			expect(rows[0]?.mailboxId).toBe(mailboxId);
		});
	});

	it('rejects reserving on a personal mailbox', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		let personalId!: Id<'mailboxes'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			personalId = await ctx.db.insert('mailboxes', {
				userId: 'admin-user',
				organizationId: 'test-org',
				address: 'me@hinterland.camp',
				domain: 'hinterland.camp',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
				mailboxId: personalId,
				inviteeEmail: 'newbie@example.com',
			})
		).rejects.toThrow(/team inbox/i);
	});

	it('rejects an existing org member (they should be added from the list)', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await seedUserProfile(t, 'existing-user', 'existing@example.com');

		await expect(
			t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
				mailboxId,
				inviteeEmail: 'existing@example.com',
			})
		).rejects.toThrow(/already in your organization/i);
	});

	it('is idempotent for a repeat reservation of the same inbox + email', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');

		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});
		const second = await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});
		expect(second.alreadyReserved).toBe(true);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('pendingMailboxMembers').collect();
			expect(rows).toHaveLength(1);
		});
	});
});

describe('pendingMailbox.claimInboxMemberships', () => {
	it('materializes the reserved membership when the invitee accepts', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});

		// The invitee accepts: their account now exists (a profile row) and they
		// are in the org.
		setInviteeSession('newbie-user');
		await seedUserProfile(t, 'newbie-user', 'newbie@example.com');

		const result = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(result.claimed).toEqual(['support@hinterland.camp']);

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'newbie-user')
				)
				.unique();
			expect(membership?.role).toBe('member');

			const grants = await ctx.db.query('pendingMailboxMembers').collect();
			expect(grants).toHaveLength(0); // consumed
		});
	});

	it('binds the grant to the invitee email — a different-email accept cannot claim it', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});

		// Someone else accepts an unrelated invite in the same org — they must not
		// inherit the grant reserved for newbie@.
		setInviteeSession('impostor-user');
		await seedUserProfile(t, 'impostor-user', 'impostor@example.com');
		const stolen = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(stolen.claimed).toEqual([]);

		await t.run(async (ctx) => {
			const impostorMembership = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'impostor-user')
				)
				.unique();
			expect(impostorMembership).toBeNull();
			const grants = await ctx.db.query('pendingMailboxMembers').collect();
			expect(grants).toHaveLength(1); // still waiting for the real invitee
		});

		// The real invitee (case-insensitive) claims it.
		setInviteeSession('newbie-user');
		await seedUserProfile(t, 'newbie-user', 'Newbie@Example.com');
		const claimed = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(claimed.claimed).toEqual(['support@hinterland.camp']);
	});

	it('is idempotent on a second accept (membership stays single)', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});

		setInviteeSession('newbie-user');
		await seedUserProfile(t, 'newbie-user', 'newbie@example.com');

		const first = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(first.claimed).toEqual(['support@hinterland.camp']);
		const second = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(second.claimed).toEqual([]);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'newbie-user')
				)
				.collect();
			expect(rows).toHaveLength(1);
		});
	});
});

describe('pendingMailbox.cancelInboxMembershipsForEmail', () => {
	it('sweeps every un-claimed grant for the email in the caller org', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const supportId = await seedSharedMailbox(t, 'support@hinterland.camp');
		const salesId = await seedSharedMailbox(t, 'sales@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId: supportId,
			inviteeEmail: 'newbie@example.com',
		});
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId: salesId,
			inviteeEmail: 'newbie@example.com',
		});

		const result = await t.mutation(api.mail.pendingMailbox.cancelInboxMembershipsForEmail, {
			inviteeEmail: 'Newbie@Example.com', // case-insensitive
		});
		expect(result.canceled).toBe(2);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('pendingMailboxMembers').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('scopes the sweep to one inbox when mailboxId is given, leaving siblings live', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const supportId = await seedSharedMailbox(t, 'support@hinterland.camp');
		const salesId = await seedSharedMailbox(t, 'sales@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId: supportId,
			inviteeEmail: 'newbie@example.com',
		});
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId: salesId,
			inviteeEmail: 'newbie@example.com',
		});

		// Roll back only the sales grant (the reserve-failed-invite rollback path).
		const result = await t.mutation(api.mail.pendingMailbox.cancelInboxMembershipsForEmail, {
			inviteeEmail: 'newbie@example.com',
			mailboxId: salesId,
		});
		expect(result.canceled).toBe(1);

		// The support grant survives and still materializes on accept.
		setInviteeSession('newbie-user');
		await seedUserProfile(t, 'newbie-user', 'newbie@example.com');
		const claimed = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(claimed.claimed).toEqual(['support@hinterland.camp']);

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', supportId).eq('authUserId', 'newbie-user')
				)
				.unique();
			expect(membership?.role).toBe('member');
		});
	});

	it('leaves a subsequent accept with no membership to claim', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});
		await t.mutation(api.mail.pendingMailbox.cancelInboxMembershipsForEmail, {
			inviteeEmail: 'newbie@example.com',
		});

		setInviteeSession('newbie-user');
		await seedUserProfile(t, 'newbie-user', 'newbie@example.com');
		const claimed = await t.mutation(api.mail.pendingMailbox.claimInboxMemberships, {});
		expect(claimed.claimed).toEqual([]);
	});
});

describe('mail.mailbox.remove cascade', () => {
	it('drops pending grants pointing at a deleted team inbox', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		const mailboxId = await seedSharedMailbox(t, 'support@hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.reserveInboxMembership, {
			mailboxId,
			inviteeEmail: 'newbie@example.com',
		});

		await t.mutation(api.mail.mailbox.remove, { mailboxId });

		await t.run(async (ctx) => {
			const grants = await ctx.db
				.query('pendingMailboxMembers')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(grants).toHaveLength(0);
		});
	});
});
