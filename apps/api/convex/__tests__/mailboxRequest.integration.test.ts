/**
 * Coverage for mail/mailboxRequest.ts — the honest dead-end of the fresh-start
 * flow:
 *   - request: self-auth, idempotent reuse of the open row, active-only
 *     "already has a mailbox" refusal, note length cap
 *   - freshStartStatus: active-only mailbox derivation, reservation surfacing,
 *     open-request flag
 *   - listPending / resolve: admin gating and org isolation
 *
 * Also covers auth/userOnboarding.completeFreshStart's refuse-without-mailbox
 * rule (the fresh-path completion mapping), which lost its only test when the
 * freshPathOnboardingEffects seam was deleted.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	getMutationContext: vi.fn(),
	getBetterAuthSessionWithRole: vi.fn(),
	requireOrgMember: vi.fn(),
	requireAdminContext: vi.fn(),
	// listPending gates reads via requireOrgPermission; completeFreshStart via
	// requireSelf. Both are called internally in sessionOrganization.ts, so the
	// export mock is what the consuming module actually invokes.
	requireOrgPermission: vi.fn(),
	requireSelf: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getMutationContext: sessionMocks.getMutationContext,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireOrgMember: sessionMocks.requireOrgMember,
		requireAdminContext: sessionMocks.requireAdminContext,
		requireOrgPermission: sessionMocks.requireOrgPermission,
		requireSelf: sessionMocks.requireSelf,
	};
});

function setMemberSession(userId: string, orgId = 'test-org') {
	sessionMocks.getMutationContext.mockResolvedValue({ userId, role: 'editor' });
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'editor',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireOrgMember.mockResolvedValue({ userId, role: 'editor' });
	sessionMocks.requireAdminContext.mockImplementation(async () => {
		throw new Error('Only owners and admins can perform this action');
	});
	// A member (editor) fails the admin-gated read closed.
	sessionMocks.requireOrgPermission.mockImplementation(async () => {
		throw new Error("You don't have permission to perform this action");
	});
	// requireSelf resolves to the caller's own id (the flows only touch self).
	sessionMocks.requireSelf.mockImplementation(async (_ctx: unknown, uid: string) => uid);
}

function setAdminSession(userId = 'admin-user', orgId = 'test-org') {
	sessionMocks.getMutationContext.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'owner',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireOrgMember.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.requireAdminContext.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.requireOrgPermission.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.requireSelf.mockImplementation(async (_ctx: unknown, uid: string) => uid);
}

async function seedUserProfile(
	t: ReturnType<typeof convexTest>,
	userId: string,
	email: string,
	name?: string
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email,
			name,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedMailbox(
	t: ReturnType<typeof convexTest>,
	userId: string,
	address: string,
	status: 'active' | 'suspended',
	orgId = 'test-org'
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailboxes', {
			userId,
			organizationId: orgId,
			address,
			domain: address.split('@')[1] ?? 'hinterland.camp',
			status,
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function seedVerifiedDomain(t: ReturnType<typeof convexTest>, domain = 'hinterland.camp') {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('domains', {
			domain,
			status: 'verified',
			dnsRecords: {
				spf: { type: 'TXT' as const, host: '@', value: 'v=spf1 -all' },
				dkim: [],
				dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
				mailFrom: [],
			},
			createdAt: now,
			updatedAt: now,
		});
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe('mailboxRequest.request', () => {
	it('inserts an open request naming the member for a mailbox-less user', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com', 'Member A');

		const result = await t.mutation(api.mail.mailboxRequest.request, { note: 'I need one' });
		expect(result.requested).toBe(true);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('mailboxRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'member-a'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe('open');
			expect(rows[0]?.requesterEmail).toBe('member-a@example.com');
			expect(rows[0]?.requesterName).toBe('Member A');
			expect(rows[0]?.note).toBe('I need one');
			expect(rows[0]?.organizationId).toBe('test-org');
		});
	});

	it('is idempotent: a second request reuses the open row and refreshes the note', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');

		const first = await t.mutation(api.mail.mailboxRequest.request, { note: 'first' });
		const second = await t.mutation(api.mail.mailboxRequest.request, { note: 'second' });
		expect(second.requestId).toBe(first.requestId);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('mailboxRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'member-a'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.note).toBe('second');
		});
	});

	it('refuses when the caller already has an ACTIVE mailbox', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'active');

		await expect(t.mutation(api.mail.mailboxRequest.request, {})).rejects.toThrow(
			/already have a mailbox/i
		);
	});

	it('ALLOWS a request when the caller only has a suspended mailbox (the escape hatch works)', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'suspended');

		const result = await t.mutation(api.mail.mailboxRequest.request, {});
		expect(result.requested).toBe(true);
	});

	it('rejects a note longer than the length cap', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');

		await expect(
			t.mutation(api.mail.mailboxRequest.request, { note: 'x'.repeat(501) })
		).rejects.toThrow(/characters or fewer/i);
	});
});

describe('mailboxRequest.freshStartStatus', () => {
	it('reports hasMailbox for an active mailbox', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'active');

		const status = await t.query(api.mail.mailboxRequest.freshStartStatus, {});
		expect(status.hasMailbox).toBe(true);
		expect(status.reservedAddress).toBeNull();
	});

	it('a suspended mailbox does NOT count, and surfaces reservation + open request', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'suspended');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-1',
				inviteeEmail: 'member-a@example.com',
				organizationId: 'test-org',
				localpart: 'member-a',
				domain: 'hinterland.camp',
				address: 'member-a@hinterland.camp',
				createdAt: now,
				createdByUserId: 'admin-user',
			});
			await ctx.db.insert('mailboxRequests', {
				authUserId: 'member-a',
				organizationId: 'test-org',
				requesterEmail: 'member-a@example.com',
				status: 'open',
				createdAt: now,
			});
		});

		const status = await t.query(api.mail.mailboxRequest.freshStartStatus, {});
		expect(status.hasMailbox).toBe(false);
		expect(status.reservedAddress).toBe('member-a@hinterland.camp');
		expect(status.hasOpenRequest).toBe(true);
		// No verified domain row for hinterland.camp → the reservation is awaiting
		// verification (early-instance invite).
		expect(status.reservationAwaitingDomain).toBe(true);
	});

	it('clears reservationAwaitingDomain once the reserved domain is verified', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('domains', {
				domain: 'hinterland.camp',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-1',
				inviteeEmail: 'member-a@example.com',
				organizationId: 'test-org',
				localpart: 'member-a',
				domain: 'hinterland.camp',
				address: 'member-a@hinterland.camp',
				createdAt: now,
				createdByUserId: 'admin-user',
			});
		});

		const status = await t.query(api.mail.mailboxRequest.freshStartStatus, {});
		expect(status.reservedAddress).toBe('member-a@hinterland.camp');
		expect(status.reservationAwaitingDomain).toBe(false);
	});
});

describe('mailboxRequest.listPending / resolve', () => {
	it('lists open requests for the caller org and resolves them', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession();
		const open = await t.query(api.mail.mailboxRequest.listPending, {});
		expect(open).toHaveLength(1);
		const first = open[0];
		if (!first) throw new Error('expected one open request');
		expect(first.email).toBe('member-a@example.com');

		const result = await t.mutation(api.mail.mailboxRequest.resolve, { requestId: first.id });
		expect(result.resolved).toBe(true);

		const afterResolve = await t.query(api.mail.mailboxRequest.listPending, {});
		expect(afterResolve).toHaveLength(0);
	});

	it('rejects resolving a request from a different organization', async () => {
		setMemberSession('member-a', 'org-1');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession('admin-user', 'org-2');
		await expect(
			t.mutation(api.mail.mailboxRequest.resolve, { requestId: created.requestId })
		).rejects.toThrow(/not accessible/i);
	});

	it('a non-admin member cannot list pending requests (fails closed)', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await t.mutation(api.mail.mailboxRequest.request, {});

		// Still a member: the admin-gated read must refuse.
		await expect(t.query(api.mail.mailboxRequest.listPending, {})).rejects.toThrow(/permission/i);
	});
});

describe('mailboxRequest.provisionFromRequest', () => {
	it('provisions a hosted mailbox on a verified domain, fulfils it, and notifies the requester', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com', 'Member A');
		// The requester's login email is external (example.com); the hosted mailbox
		// must be stood up on the deployment's VERIFIED sending domain, not there.
		await seedVerifiedDomain(t, 'hinterland.camp');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession();
		const result = await t.mutation(api.mail.mailboxRequest.provisionFromRequest, {
			requestId: created.requestId,
		});
		expect(result.fulfilled).toBe(true);

		// A live hosted mailbox now exists at localpart@<verified domain> — never at
		// the requester's external login address.
		await t.run(async (ctx) => {
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'member-a'))
				.collect();
			expect(mailboxes).toHaveLength(1);
			expect(mailboxes[0]?.address).toBe('member-a@hinterland.camp');
			expect(mailboxes[0]?.status).toBe('active');
			expect(mailboxes[0]?.kind ?? 'hosted').toBe('hosted');

			// The request is FULFILLED (not merely acknowledged), audit-stamped.
			const request = await ctx.db.get(created.requestId);
			expect(request?.status).toBe('fulfilled');
			expect(request?.fulfilledMailboxId).toBe(result.mailboxId);
			expect(request?.resolvedByUserId).toBe('admin-user');
			expect(request?.resolvedAt).toBeTypeOf('number');

			// The requester is notified in-app: onboarding flips to mailbox-ready.
			const onboarding = await ctx.db
				.query('userOnboarding')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'member-a'))
				.first();
			expect(onboarding?.mailboxReady).toBeTypeOf('number');
		});

		// It's off the admin's open list, and the requester's fresh-start guard now
		// admits them to the inbox.
		const stillOpen = await t.query(api.mail.mailboxRequest.listPending, {});
		expect(stillOpen).toHaveLength(0);

		setMemberSession('member-a');
		const status = await t.query(api.mail.mailboxRequest.freshStartStatus, {});
		expect(status.hasMailbox).toBe(true);
	});

	it('is idempotent: a redelivered provision returns the same mailbox, no second one', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedVerifiedDomain(t, 'hinterland.camp');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession();
		const first = await t.mutation(api.mail.mailboxRequest.provisionFromRequest, {
			requestId: created.requestId,
		});
		const second = await t.mutation(api.mail.mailboxRequest.provisionFromRequest, {
			requestId: created.requestId,
		});
		expect(second.mailboxId).toBe(first.mailboxId);

		await t.run(async (ctx) => {
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'member-a'))
				.collect();
			expect(mailboxes).toHaveLength(1);
		});
	});

	it('fulfils against an existing live mailbox instead of standing up a second one', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		// An open request coexisting with a live mailbox (e.g. the requester claimed
		// a reservation after asking): the provision must fulfil against it.
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'active');
		const requestId = await t.run(async (ctx) =>
			ctx.db.insert('mailboxRequests', {
				authUserId: 'member-a',
				organizationId: 'test-org',
				requesterEmail: 'member-a@example.com',
				status: 'open',
				createdAt: Date.now(),
			})
		);

		setAdminSession();
		const result = await t.mutation(api.mail.mailboxRequest.provisionFromRequest, { requestId });

		await t.run(async (ctx) => {
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'member-a'))
				.collect();
			expect(mailboxes).toHaveLength(1);
			expect(result.mailboxId).toBe(mailboxes[0]?._id);
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('fulfilled');
		});
	});

	it('honours a reservation: provisions the reserved address and consumes it', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		// The reserved domain must be verified — the claim gate refuses to stand up
		// a hosted mailbox on an unverified domain (also proves the verified path is
		// unchanged for the admin provision-from-request flow).
		await seedVerifiedDomain(t, 'hinterland.camp');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});
		await t.run(async (ctx) => {
			await ctx.db.insert('pendingMailboxes', {
				invitationId: 'inv-1',
				inviteeEmail: 'member-a@example.com',
				organizationId: 'test-org',
				localpart: 'member-a',
				domain: 'hinterland.camp',
				address: 'member-a@hinterland.camp',
				createdAt: Date.now(),
				createdByUserId: 'admin-user',
			});
		});

		setAdminSession();
		const result = await t.mutation(api.mail.mailboxRequest.provisionFromRequest, {
			requestId: created.requestId,
		});

		await t.run(async (ctx) => {
			const mailbox = await ctx.db.get(result.mailboxId);
			expect(mailbox?.address).toBe('member-a@hinterland.camp');
			// The reservation was consumed, not orphaned.
			const remaining = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitee_email', (q) => q.eq('inviteeEmail', 'member-a@example.com'))
				.collect();
			expect(remaining).toHaveLength(0);
		});
	});

	it('refuses to provision when no sending domain is verified (no dead inbox)', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		// No verified domain seeded: standing up a hosted mailbox at the requester's
		// external login address would be a dead inbox, so the server refuses.
		setAdminSession();
		await expect(
			t.mutation(api.mail.mailboxRequest.provisionFromRequest, { requestId: created.requestId })
		).rejects.toThrow(/verify a sending domain/i);

		await t.run(async (ctx) => {
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'member-a'))
				.collect();
			expect(mailboxes).toHaveLength(0);
			const request = await ctx.db.get(created.requestId);
			expect(request?.status).toBe('open');
		});
	});

	it('refuses a move-raised request and leaves the move untouched', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedVerifiedDomain(t, 'hinterland.camp');

		// A move-raised request: the mover's ACTIVE EXTERNAL mailbox stays live and a
		// mailboxMoves row links to the request. Provisioning here would strand the
		// move, so the admin is pointed at the move flow instead.
		const { requestId, moveId } = await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'member-a',
				organizationId: 'test-org',
				address: 'member-a@gmail.com',
				domain: 'gmail.com',
				kind: 'external',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: 'member-a',
				organizationId: 'test-org',
				mailboxId,
				imapHost: 'imap.gmail.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.gmail.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password',
				imapUsername: 'member-a@gmail.com',
				secretCiphertext: 'x',
				secretIv: 'x',
				secretAuthTag: 'x',
				secretEnvelopeVersion: 1,
				status: 'connected',
				createdAt: now,
				updatedAt: now,
			});
			const requestId = await ctx.db.insert('mailboxRequests', {
				authUserId: 'member-a',
				organizationId: 'test-org',
				requesterEmail: 'member-a@gmail.com',
				status: 'open',
				createdAt: now,
			});
			const moveId = await ctx.db.insert('mailboxMoves', {
				userId: 'member-a',
				organizationId: 'test-org',
				accountId,
				sourceMailboxId: mailboxId,
				address: 'member-a@gmail.com',
				domain: 'gmail.com',
				stage: 'provisioning',
				isPaused: false,
				provisionRequestId: requestId,
				createdAt: now,
				updatedAt: now,
			});
			return { requestId, moveId };
		});

		setAdminSession();
		await expect(
			t.mutation(api.mail.mailboxRequest.provisionFromRequest, { requestId })
		).rejects.toThrow(/mailbox move/i);

		await t.run(async (ctx) => {
			// The request is still open, the move still at 'provisioning', and no
			// hosted mailbox was stood up against the external address.
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('open');
			const move = await ctx.db.get(moveId);
			expect(move?.stage).toBe('provisioning');
			expect(move?.hostedMailboxId).toBeUndefined();
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'member-a'))
				.collect();
			expect(mailboxes).toHaveLength(1);
			expect(mailboxes[0]?.kind).toBe('external');
		});
	});

	it('resolve does not downgrade an already-fulfilled request', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedVerifiedDomain(t, 'hinterland.camp');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession();
		await t.mutation(api.mail.mailboxRequest.provisionFromRequest, {
			requestId: created.requestId,
		});

		// A stale 'Mark done' racing the provision must be a no-op, not a downgrade.
		const result = await t.mutation(api.mail.mailboxRequest.resolve, {
			requestId: created.requestId,
		});
		expect(result.resolved).toBe(true);
		await t.run(async (ctx) => {
			const request = await ctx.db.get(created.requestId);
			expect(request?.status).toBe('fulfilled');
		});
	});

	it('is admin-gated: a member cannot provision from a request (fails closed)', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		// Still a member: the admin-gated provision must refuse.
		await expect(
			t.mutation(api.mail.mailboxRequest.provisionFromRequest, { requestId: created.requestId })
		).rejects.toThrow(/owners and admins/i);
	});

	it('rejects provisioning a request from a different organization', async () => {
		setMemberSession('member-a', 'org-1');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		const created = await t.mutation(api.mail.mailboxRequest.request, {});

		setAdminSession('admin-user', 'org-2');
		await expect(
			t.mutation(api.mail.mailboxRequest.provisionFromRequest, { requestId: created.requestId })
		).rejects.toThrow(/not accessible/i);
	});
});

describe('userOnboarding.completeFreshStart', () => {
	it("refuses with 'No mailbox yet' when the caller has no mailbox", async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');

		await expect(
			t.mutation(api.auth.userOnboarding.completeFreshStart, { userId: 'member-a' })
		).rejects.toThrow(/No mailbox yet/i);
	});

	it("refuses when the caller's only mailbox is suspended", async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'suspended');

		await expect(
			t.mutation(api.auth.userOnboarding.completeFreshStart, { userId: 'member-a' })
		).rejects.toThrow(/No mailbox yet/i);
	});

	it('marks mailboxReady when the caller has an active mailbox', async () => {
		setMemberSession('member-a');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'member-a', 'member-a@example.com');
		await seedMailbox(t, 'member-a', 'member-a@hinterland.camp', 'active');

		await t.mutation(api.auth.userOnboarding.completeFreshStart, { userId: 'member-a' });

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('userOnboarding')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'member-a'))
				.first();
			expect(row?.mailboxReady).toBeTypeOf('number');
		});
	});
});
