/**
 * Coverage for mail/pendingMailbox.ts:
 *   - setForInvitation: admin gating, domain verification, dup-check
 *   - cancelForInvitation: deletes pending row, no-op when missing
 *   - claimForInvitation: provisions the live mailbox + folders + cleans up
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { claimReservationsForVerifiedDomain } from '../mail/pendingMailbox';

const sessionMocks = vi.hoisted(() => ({
	getMutationContext: vi.fn(),
	getBetterAuthSessionWithRole: vi.fn(),
	requireAdminContext: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
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

async function seedUserProfile(t: ReturnType<typeof convexTest>, userId: string, email: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

function setEditorSession(userId = 'editor-user', orgId = 'test-org') {
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

async function seedVerifiedDomain(
	t: ReturnType<typeof convexTest>,
	domain: string
): Promise<Id<'domains'>> {
	let id!: Id<'domains'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('domains', {
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
	return id;
}

async function seedPendingDomain(
	t: ReturnType<typeof convexTest>,
	domain: string
): Promise<Id<'domains'>> {
	let id!: Id<'domains'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('domains', {
			domain,
			status: 'pending',
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
	return id;
}

describe('pendingMailbox.setForInvitation', () => {
	it('reserves a mailbox on a verified domain', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');

		const result = await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
			displayName: 'Marcel Pfeifer',
		});

		expect(result.address).toBe('marcel@hinterland.camp');
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(row).toBeTruthy();
			expect(row?.address).toBe('marcel@hinterland.camp');
			expect(row?.displayName).toBe('Marcel Pfeifer');
			expect(row?.createdByUserId).toBe('admin-user');
		});
	});

	it('rejects non-admin callers', async () => {
		setEditorSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-1',
				inviteeEmail: 'invitee@example.com',
				localpart: 'marcel',
				domain: 'hinterland.camp',
			})
		).rejects.toThrow();
	});

	it('reserves the intent on a not-yet-verified domain (early-instance invite)', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedPendingDomain(t, 'verifying.example');

		const result = await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-early',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'verifying.example',
		});

		expect(result.address).toBe('marcel@verifying.example');
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-early'))
				.first();
			expect(row?.address).toBe('marcel@verifying.example');
		});
	});

	it('rejects a domain this instance does not host at all', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-1',
				inviteeEmail: 'invitee@example.com',
				localpart: 'marcel',
				domain: 'not-here.example',
			})
		).rejects.toThrow(/Add not-here\.example as a sending domain/i);
	});

	it('rejects a domain that failed verification', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('domains', {
				domain: 'broken.example',
				status: 'failed',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-1',
				inviteeEmail: 'invitee@example.com',
				localpart: 'marcel',
				domain: 'broken.example',
			})
		).rejects.toThrow(/failed verification/i);
	});

	it('rejects an invalid local part', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-1',
				inviteeEmail: 'invitee@example.com',
				localpart: 'has spaces',
				domain: 'hinterland.camp',
			})
		).rejects.toThrow(/local part/i);
	});

	it('rejects when an active mailbox already owns the address', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailboxes', {
				userId: 'other-user',
				organizationId: 'test-org',
				address: 'marcel@hinterland.camp',
				domain: 'hinterland.camp',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-1',
				inviteeEmail: 'invitee@example.com',
				localpart: 'marcel',
				domain: 'hinterland.camp',
			})
		).rejects.toThrow(/already exists/i);
	});

	it('rejects when another pending invite already reserved the address', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');

		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-a',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		await expect(
			t.mutation(api.mail.pendingMailbox.setForInvitation, {
				invitationId: 'inv-b',
				inviteeEmail: 'invitee@example.com',
				localpart: 'marcel',
				domain: 'hinterland.camp',
			})
		).rejects.toThrow(/already reserved/i);
	});

	it('replaces an existing pending row for the same invitation', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');

		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'first-pick',
			domain: 'hinterland.camp',
		});
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'second-pick',
			domain: 'hinterland.camp',
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.localpart).toBe('second-pick');
		});
	});
});

describe('pendingMailbox.cancelForInvitation', () => {
	it('deletes the pending row when present', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		const result = await t.mutation(api.mail.pendingMailbox.cancelForInvitation, {
			invitationId: 'inv-1',
		});
		expect(result.canceled).toBe(true);

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(row).toBeNull();
		});
	});

	it('is a no-op when no pending row exists', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.mail.pendingMailbox.cancelForInvitation, {
			invitationId: 'nope',
		});
		expect(result.canceled).toBe(false);
	});
});

describe('pendingMailbox.claimForInvitation', () => {
	it('provisions the live mailbox + folders for the accepting user', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
			displayName: 'Marcel Pfeifer',
		});

		// Switch the session to the freshly-accepted invitee.
		setAdminSession('invitee-user', 'test-org');
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');

		const result = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-1',
		});
		expect(result.created).toBe(true);
		if (result.created !== true) throw new Error('typeguard');

		await t.run(async (ctx) => {
			const mailbox = await ctx.db.get(result.mailboxId);
			expect(mailbox?.address).toBe('marcel@hinterland.camp');
			expect(mailbox?.userId).toBe('invitee-user');
			expect(mailbox?.displayName).toBe('Marcel Pfeifer');
			expect(mailbox?.status).toBe('active');

			const folders = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', result.mailboxId))
				.collect();
			expect(folders).toHaveLength(6);

			const pending = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(pending).toBeNull();
		});
	});

	it('returns created:false when no reservation exists', async () => {
		setAdminSession('invitee-user', 'test-org');
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'never-existed',
		});
		expect(result.created).toBe(false);
	});

	it('is idempotent on a second call', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		setAdminSession('invitee-user', 'test-org');
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');
		const first = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-1',
		});
		expect(first.created).toBe(true);
		const second = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-1',
		});
		expect(second.created).toBe(false);
	});

	it('drops the pending row and reports address_taken when a live mailbox now owns the address', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		// Someone else takes the live address in the meantime.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailboxes', {
				userId: 'other-user',
				organizationId: 'test-org',
				address: 'marcel@hinterland.camp',
				domain: 'hinterland.camp',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		setAdminSession('invitee-user', 'test-org');
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');
		const result = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-1',
		});
		expect(result.created).toBe(false);
		if (result.created === false) {
			expect(result.error).toBe('address_taken');
		}
		await t.run(async (ctx) => {
			const pending = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(pending).toBeNull();
		});
	});

	it('rejects the claim if the caller is in a different organization', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-1',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		setAdminSession('invitee-user', 'other-org');
		const result = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-1',
		});
		expect(result.created).toBe(false);
		if (result.created === false) {
			expect(result.error).toBe('organization_mismatch');
		}
	});
});

describe('pendingMailbox.claimForInvitation — invitee binding', () => {
	it('refuses a different org member and keeps the row for the real invitee', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t, 'hinterland.camp');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-bind',
			inviteeEmail: 'Invitee@Example.com',
			localpart: 'marcel',
			domain: 'hinterland.camp',
		});

		// A different member who learned the invitation id tries to claim it.
		setAdminSession('impostor-user', 'test-org');
		await seedUserProfile(t, 'impostor-user', 'impostor@example.com');
		const stolen = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-bind',
		});
		expect(stolen.created).toBe(false);
		if (stolen.created === false) expect(stolen.error).toBe('invitee_mismatch');

		// The real invitee (case-insensitive email match) still succeeds.
		setAdminSession('real-invitee', 'test-org');
		await seedUserProfile(t, 'real-invitee', 'invitee@example.com');
		const claimed = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-bind',
		});
		expect(claimed.created).toBe(true);
	});
});

describe('pendingMailbox — early-instance (pre-verification) reservation', () => {
	it('parks the accepting invitee in awaiting_domain and keeps the reservation', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		await seedPendingDomain(t, 'verifying.example');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-early',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'verifying.example',
		});

		// The invitee accepts BEFORE the domain verifies: no live mailbox yet, the
		// reservation must survive so it can activate on verify.
		setAdminSession('invitee-user', 'test-org');
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');
		const result = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-early',
		});

		expect(result.created).toBe(false);
		if (result.created === false) {
			expect(result.error).toBe('awaiting_domain');
		}
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-early'))
				.first();
			expect(row).toBeTruthy();
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', 'invitee-user'))
				.first();
			expect(mailbox).toBeNull();
		});
	});

	it('claims reserved mailboxes for already-accepted invitees when the domain verifies', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'verifying.example');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-early',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'verifying.example',
		});

		// The invitee ACCEPTS before verify: the claim parks in awaiting_domain and
		// stamps the reservation with the accepting userId — that stamp (not an
		// email match) is what the sweep keys on.
		setAdminSession('invitee-user', 'test-org');
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');
		const parked = await t.mutation(api.mail.pendingMailbox.claimForInvitation, {
			invitationId: 'inv-early',
		});
		expect(parked.created).toBe(false);

		// The domain verifies → the lifecycle sweep provisions the parked mailbox.
		await t.run(async (ctx) => {
			await ctx.db.patch(domainId, { status: 'verified' });
			const provisioned = await claimReservationsForVerifiedDomain(ctx, 'verifying.example');
			expect(provisioned).toBe(1);
		});

		await t.run(async (ctx) => {
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'marcel@verifying.example'))
				.first();
			expect(mailbox?.userId).toBe('invitee-user');
			expect(mailbox?.status).toBe('active');

			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-early'))
				.first();
			expect(row).toBeNull();
		});
	});

	it('leaves reservations for not-yet-accepted invitees untouched on verify', async () => {
		setAdminSession('admin-user', 'test-org');
		const t = convexTest(schema, modules);
		const domainId = await seedPendingDomain(t, 'verifying.example');
		await t.mutation(api.mail.pendingMailbox.setForInvitation, {
			invitationId: 'inv-early',
			inviteeEmail: 'invitee@example.com',
			localpart: 'marcel',
			domain: 'verifying.example',
		});
		// A profile exists for the invitee email (they REGISTERED via the invite
		// link — register.vue creates the profile before the accept step) but they
		// never accepted, so the reservation carries no acceptedByUserId. The sweep
		// must NOT provision them: acceptance is read from the stamp, never
		// re-derived by matching the email against userProfiles.
		await seedUserProfile(t, 'invitee-user', 'invitee@example.com');

		await t.run(async (ctx) => {
			await ctx.db.patch(domainId, { status: 'verified' });
			const provisioned = await claimReservationsForVerifiedDomain(ctx, 'verifying.example');
			expect(provisioned).toBe(0);
			const row = await ctx.db
				.query('pendingMailboxes')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-early'))
				.first();
			expect(row).toBeTruthy();
		});
	});
});
