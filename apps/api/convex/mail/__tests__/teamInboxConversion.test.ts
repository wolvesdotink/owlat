/**
 * Turning an existing personal mailbox into a team inbox
 * (`mail/teamInboxConversion.ts`), and what that one scope change does to the
 * rest of the model: teammates get read + send access, the account stops being
 * the owner's personal connection, and the From identity is judged by the
 * transport the mailbox actually sends through.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => {
		if (sessionMock.role === null) throw new Error('Not authenticated');
		return {
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		};
	};
	const admin = () => {
		if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
			throw new Error('Only owners and admins can perform this action');
		}
		return session();
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		requireOrgPermission: vi.fn(async () => admin()),
		requireAdminContext: vi.fn(async () => admin()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => (sessionMock.role === null ? null : session())),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null) {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

async function setup(): Promise<TestConvex<typeof schema>> {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: now,
		});
		for (const authUserId of ['admin-user', 'user-B', 'editor-user']) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@owlat.test`,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
	return t;
}

const CREDS = {
	imapHost: 'imap.gmail.test',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.test',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'info@acme.test',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

/** The team's `info@` connected the old way: as the admin's PERSONAL account. */
async function connectPersonally(
	t: TestConvex<typeof schema>,
	userId = 'admin-user',
	role: 'admin' | 'editor' = 'admin'
): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> {
	setSession(userId, role);
	return t.mutation(internal.mail.external.accounts._connectInternal, {
		...CREDS,
		emailAddress: 'info@acme.test',
	});
}

/** Insert a bare mailbox row owned by `userId`. */
async function insertMailbox(
	t: TestConvex<typeof schema>,
	fields: { address: string; userId?: string; organizationId?: string; scope?: 'seed' | 'shared' }
): Promise<Id<'mailboxes'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('mailboxes', {
			userId: fields.userId ?? 'admin-user',
			organizationId: fields.organizationId ?? 'org-1',
			address: fields.address,
			domain: fields.address.split('@')[1]!,
			kind: 'hosted',
			scope: fields.scope,
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('convertibleMailboxes', () => {
	it("offers the caller's own connected personal mailbox, and nothing that is already shared", async () => {
		const t = await setup();
		const { mailboxId } = await connectPersonally(t);
		await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			memberUserIds: [],
		});

		const offered = await t.query(api.mail.teamInboxConversion.convertibleMailboxes, {});
		expect(offered).toEqual([
			{ mailboxId, address: 'info@acme.test', displayName: 'info@acme.test' },
		]);
	});

	it('offers a hosted personal mailbox, but not a seed or a mailbox in another organization', async () => {
		const t = await setup();
		setSession('admin-user', 'admin');
		const hosted = await insertMailbox(t, { address: 'hello@acme.test' });
		await insertMailbox(t, { address: 'seed@consumer.test', scope: 'seed' });
		await insertMailbox(t, { address: 'me@other.test', organizationId: 'org-2' });

		const offered = await t.query(api.mail.teamInboxConversion.convertibleMailboxes, {});
		expect(offered.map((mb) => mb.mailboxId)).toEqual([hosted]);
	});

	it('does not offer a disconnected mailbox', async () => {
		const t = await setup();
		await connectPersonally(t);
		await t.mutation(api.mail.external.accounts.disconnect, {});
		expect(await t.query(api.mail.teamInboxConversion.convertibleMailboxes, {})).toEqual([]);
	});
});

describe('convertToTeamInbox', () => {
	it('makes the mailbox a team inbox the added teammates can read and send from', async () => {
		const t = await setup();
		const { mailboxId, externalAccountId } = await connectPersonally(t);

		await t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
			mailboxId,
			memberUserIds: ['user-B'],
			displayName: '  Info  ',
		});

		const mailbox = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(mailbox?.scope).toBe('shared');
		expect(mailbox?.displayName).toBe('Info');
		expect(mailbox?.userId).toBe('admin-user');
		// Transport and credentials are untouched: same account, still syncing.
		expect(mailbox?.externalAccountId).toBe(externalAccountId);
		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.status).toBe('pending');
		expect(account?.secretCiphertext).toBe('ct');

		const listed = await t.query(api.mail.mailboxMembers.listShared, {});
		expect(listed.map((row) => row._id)).toContain(mailboxId);

		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId })).toBe('member');
		const accessible = await t.query(api.mail.mailbox.queries.accessible, {});
		expect(accessible).toEqual([expect.objectContaining({ mailboxId, scope: 'shared' })]);
		const identities = await t.query(api.mail.identities.listSendAsIdentities, { mailboxId });
		expect(identities).toEqual([
			expect.objectContaining({
				address: 'info@acme.test',
				kind: 'team',
				domainVerified: true,
				alignment: 'aligned',
			}),
		]);

		const audit = await t.run((ctx) => ctx.db.query('mailAuditLog').collect());
		expect(audit.map((row) => row.event)).toContain('mailbox.converted_to_team_inbox');
	});

	it("releases the owner's personal-account slot: the connected-mailbox card empties and a new personal account can connect", async () => {
		const t = await setup();
		const { mailboxId } = await connectPersonally(t);
		await t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
			mailboxId,
			memberUserIds: [],
		});

		expect(await t.query(api.mail.external.accounts.getForCurrentUser, {})).toEqual({
			configured: false,
		});
		// Disconnect is a personal surface; it must not be able to reach the team inbox.
		await expect(t.mutation(api.mail.external.accounts.disconnect, {})).rejects.toThrow(
			/not found/i
		);
		const second = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'admin@acme.test',
			imapUsername: 'admin@acme.test',
		});
		expect(second.mailboxId).not.toBe(mailboxId);
	});

	it('keeps writing the account-level mirror the previous release reads', async () => {
		const t = await setup();
		const { mailboxId, externalAccountId } = await connectPersonally(t);
		await t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
			mailboxId,
			memberUserIds: [],
		});
		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.scope).toBe('shared');
	});

	it("stops counting as the owner's own mailbox for the fresh-start flow", async () => {
		const t = await setup();
		setSession('admin-user', 'admin');
		const mailboxId = await insertMailbox(t, { address: 'hello@acme.test' });
		expect(await t.query(api.mail.mailboxRequest.freshStartStatus, {})).toMatchObject({
			hasMailbox: true,
		});
		await t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
			mailboxId,
			memberUserIds: [],
		});
		expect(await t.query(api.mail.mailboxRequest.freshStartStatus, {})).toMatchObject({
			hasMailbox: false,
		});
	});

	it('refuses a mailbox that is half-way through a move', async () => {
		const t = await setup();
		const { mailboxId, externalAccountId } = await connectPersonally(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailboxMoves', {
				userId: 'admin-user',
				organizationId: 'org-1',
				accountId: externalAccountId,
				sourceMailboxId: mailboxId,
				address: 'info@acme.test',
				domain: 'acme.test',
				stage: 'cutover_pending',
				isPaused: false,
				createdAt: now,
				updatedAt: now,
			});
		});
		expect(await t.query(api.mail.teamInboxConversion.convertibleMailboxes, {})).toEqual([]);
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: [],
			})
		).rejects.toThrow(/finish or cancel moving/i);
	});

	it("refuses the admin's own mailbox in another organization", async () => {
		const t = await setup();
		setSession('admin-user', 'admin');
		const mailboxId = await insertMailbox(t, {
			address: 'me@other.test',
			organizationId: 'org-2',
		});
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: [],
			})
		).rejects.toThrow(/only the owner/i);
	});

	it('rolls back when a member is not in the organization', async () => {
		const t = await setup();
		const { mailboxId } = await connectPersonally(t);
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: ['ghost-user'],
			})
		).rejects.toThrow(/not a member/i);
		const mailbox = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(mailbox?.scope).toBeUndefined();
	});

	it('refuses a caller who is not an owner or admin', async () => {
		const t = await setup();
		const { mailboxId } = await connectPersonally(t, 'editor-user', 'editor');
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: [],
			})
		).rejects.toThrow(/owners and admins/i);
	});

	it("refuses an admin converting someone else's mailbox", async () => {
		const t = await setup();
		const { mailboxId } = await connectPersonally(t, 'editor-user', 'editor');
		setSession('admin-user', 'admin');
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: ['admin-user'],
			})
		).rejects.toThrow(/only the owner/i);
	});

	it('refuses a mailbox that is no longer connected', async () => {
		const t = await setup();
		const { mailboxId, externalAccountId } = await connectPersonally(t);
		// A completed move leaves the mailbox active with a disconnected account.
		await t.run((ctx) => ctx.db.patch(externalAccountId, { status: 'disconnected' }));
		await expect(
			t.mutation(api.mail.teamInboxConversion.convertToTeamInbox, {
				mailboxId,
				memberUserIds: [],
			})
		).rejects.toThrow(/reconnect/i);
	});
});

describe('listSendAsIdentities judges an identity by the transport it ships through', () => {
	it('marks a hosted mailbox on an unverified domain unverified, but not one that sends through its own provider', async () => {
		const t = await setup();
		const { mailboxId: external } = await connectPersonally(t);
		const hosted = await t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert('mailboxes', {
				userId: 'admin-user',
				organizationId: 'org-1',
				address: 'hosted@unverified.test',
				domain: 'unverified.test',
				kind: 'hosted',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		const [externalIdentity] = await t.query(api.mail.identities.listSendAsIdentities, {
			mailboxId: external,
		});
		expect(externalIdentity).toMatchObject({ domainVerified: true, alignment: 'aligned' });

		const [hostedIdentity] = await t.query(api.mail.identities.listSendAsIdentities, {
			mailboxId: hosted,
		});
		expect(hostedIdentity?.domainVerified).toBe(false);
	});

	it('does not vouch for an alias the provider may not manage, or for a connection that is gone', async () => {
		const t = await setup();
		const { mailboxId, externalAccountId } = await connectPersonally(t);
		await t.run((ctx) =>
			ctx.db.insert('mailAliases', {
				alias: 'hello@elsewhere.test',
				targetMailboxId: mailboxId,
				organizationId: 'org-1',
				createdAt: Date.now(),
			})
		);

		const live = await t.query(api.mail.identities.listSendAsIdentities, { mailboxId });
		const byAddress = new Map(live.map((identity) => [identity.address, identity]));
		expect(byAddress.get('info@acme.test')).toMatchObject({ alignment: 'aligned' });
		expect(byAddress.get('hello@elsewhere.test')).toMatchObject({
			domainVerified: true,
			alignment: 'unknown',
		});

		// A completed move leaves the mailbox readable with its connection gone.
		await t.run((ctx) => ctx.db.patch(externalAccountId, { status: 'disconnected' }));
		const gone = await t.query(api.mail.identities.listSendAsIdentities, { mailboxId });
		expect(gone.find((identity) => identity.address === 'info@acme.test')).toMatchObject({
			alignment: 'unknown',
			alignmentReason: expect.stringMatching(/no longer connected/),
		});
	});
});
