/**
 * Integration tests for the GDPR account lifecycle (auth/accountManagement.ts +
 * the batched member-erasure job in auth/memberErasure.ts).
 *
 * Covers:
 *  - exportUserData: requireSelf rejects a foreign userId; the export omits
 *    webhook secrets + api-key hashes; soft-deleted contacts are excluded;
 *    the api-key + webhook metadata sections are populated ONLY for an
 *    org admin/owner (empty for a plain 'editor').
 *  - the account-deletion path: a non-owner member's deletion erases their
 *    auth-side rows + onboarding + profile and hands off to the batched
 *    member-erasure walk; that walk anonymizes/erases the member's mailbox,
 *    app passwords, external credentials and chat authorship, then terminates
 *    by marking the deletion request `completed`.
 *
 * The BetterAuth `member` / `organization` rows that exportUserData and the
 * deletion path read are real component rows — seeded through the
 * `components.betterAuth.adapter.create` mutation after registering the
 * component with `t.registerComponent`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { api, internal, components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// The session is parameterized per test: requireSelf passes only for the
// fixed session user, and the caller's role (owner/admin/editor) decides
// whether exportUserData surfaces the admin-only api-key/webhook metadata.
const sessionMock = vi.hoisted(() => ({
	userId: 'auth-user-1',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

// requireSelf calls getUserIdFromSession through a *local* reference, so
// mocking the export alone doesn't intercept it — mock requireSelf directly.
// requireOrgMember / getMutationContext are the authedQuery/authedMutation
// floors and must succeed for the handler to run at all.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
		requireSelf: vi.fn().mockImplementation(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMock.userId) {
				throw new Error('unauthenticated');
			}
			return sessionMock.userId;
		}),
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

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
			!path.includes('llmProvider'),
	),
);

const betterAuthModules = import.meta.glob('../betterAuth/**/*.*s');

function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	sessionMock.userId = 'auth-user-1';
	sessionMock.role = 'owner';
});

/** Seed a userProfiles row for the BetterAuth user id. */
async function seedProfile(
	t: TestConvex<typeof schema>,
	authUserId: string,
	email = 'me@example.com',
): Promise<Id<'userProfiles'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('userProfiles', {
			authUserId,
			email,
			name: 'Me',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/** Create a BetterAuth organization via the adapter; returns its _id. */
async function seedOrg(t: TestConvex<typeof schema>, name = 'Acme'): Promise<string> {
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'organization',
			data: { name, slug: name.toLowerCase(), createdAt: Date.now() },
		},
	} as never)) as { _id: string };
	return org._id;
}

/** Create a BetterAuth member row linking authUserId to org with a role. */
async function seedMember(
	t: TestConvex<typeof schema>,
	organizationId: string,
	authUserId: string,
	role: 'owner' | 'admin' | 'editor',
): Promise<void> {
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId, userId: authUserId, role, createdAt: Date.now() },
		},
	} as never);
}

// ============================================================
// exportUserData
// ============================================================

describe('accountManagement.exportUserData — requireSelf', () => {
	it('rejects a foreign userId (session is auth-user-1, asks for someone else)', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');

		await expect(
			t.query(api.auth.accountManagement.exportUserData, { userId: 'someone-else' }),
		).rejects.toThrow();
	});

	it('returns the caller-owned profile + org for their own userId', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'owner@example.com');
		const orgId = await seedOrg(t, 'Acme');
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		expect(res.userProfile.email).toBe('owner@example.com');
		expect(res.organizations).toHaveLength(1);
		expect(res.organizations[0]!.organization.name).toBe('Acme');
		expect(res.organizations[0]!.role).toBe('owner');
		expect(typeof res.exportedAt).toBe('number');
	});
});

describe('accountManagement.exportUserData — secret redaction', () => {
	it('omits webhook secrets and api-key hashes from the export', async () => {
		const t = newHarness();
		sessionMock.role = 'owner';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 'super-secret-signing-key',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'deadbeef-hash-value',
				keyPrefix: 'lm_live_',
				scopes: ['contacts:read'],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		const orgExport = res.organizations[0]!;
		expect(orgExport.data.webhooks).toHaveLength(1);
		expect(orgExport.data.apiKeys).toHaveLength(1);

		// No `secret` on any exported webhook.
		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-signing-key');
		expect(serialized).not.toContain('deadbeef-hash-value');

		expect(orgExport.data.webhooks[0]).not.toHaveProperty('secret');
		// api-key export carries only safe metadata (name/prefix/timestamps).
		expect(orgExport.data.apiKeys[0]).not.toHaveProperty('keyHash');
		expect(orgExport.data.apiKeys[0]).toMatchObject({
			name: 'key',
			keyPrefix: 'lm_live_',
		});
	});
});

describe('accountManagement.exportUserData — soft-deleted contacts', () => {
	it('excludes GDPR-erased (soft-deleted) contacts from the export', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'live@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'erased@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				deletedAt: Date.now(), // soft-deleted / GDPR-erased
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		const emails = res.organizations[0]!.data.contacts.map((c) => c.email);
		expect(emails).toContain('live@example.com');
		expect(emails).not.toContain('erased@example.com');
		expect(res.organizations[0]!.data.contacts).toHaveLength(1);
	});
});

describe('accountManagement.exportUserData — admin-only metadata gating', () => {
	it('populates api-key + webhook metadata for an org admin/owner', async () => {
		const t = newHarness();
		sessionMock.role = 'admin';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// Membership role drives the in-handler hasPermission gate.
		await seedMember(t, orgId, 'auth-user-1', 'admin');

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		expect(res.organizations[0]!.data.apiKeys).toHaveLength(1);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(1);
	});

	it('leaves api-key + webhook metadata EMPTY for a plain editor', async () => {
		const t = newHarness();
		sessionMock.role = 'editor';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// The handler reads the *membership* role (not the session) for the gate.
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		// Editor self-export can't enumerate key prefixes / webhook endpoints.
		expect(res.organizations[0]!.data.apiKeys).toHaveLength(0);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(0);
		// But non-privileged org data (contacts etc.) is still present.
		expect(res.organizations[0]!.data).toHaveProperty('contacts');
	});
});

describe('accountManagement.exportUserData — personal data (right-to-access mirror)', () => {
	it("includes the caller's own mailbox, mail, drafts, external account and chat, with secrets/blob handles redacted", async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'me@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['me@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m1@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'personal subject',
				normalizedSubject: 'personal subject',
				snippet: 'personal body snippet',
				rawStorageId,
				rawSize: 13,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['draft-recipient@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 'draft subject',
				bodyHtml: '<p>draft</p>',
				attachments: [],
				state: 'draft' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'me@example.com',
				secretCiphertext: 'super-secret-ciphertext',
				secretIv: 'super-secret-iv',
				secretAuthTag: 'super-secret-tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: 'auth-user-1',
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'auth-user-1',
				text: 'my chat message',
				createdAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'not my message',
				createdAt: now,
			});
		});

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		// Personal sections are populated for the caller's own data.
		expect(res.personalData.mailboxes).toHaveLength(1);
		expect(res.personalData.mailMessages).toHaveLength(1);
		expect(res.personalData.mailMessages[0]!.subject).toBe('personal subject');
		expect(res.personalData.mailDrafts).toHaveLength(1);
		expect(res.personalData.mailDrafts[0]!.subject).toBe('draft subject');
		expect(res.personalData.externalMailAccounts).toHaveLength(1);

		// Chat: only the caller's own authorship is exported, not others'.
		expect(res.personalData.chatMessages).toHaveLength(1);
		expect(res.personalData.chatMessages[0]!.text).toBe('my chat message');

		// Redaction: storage-blob handles and the encrypted credential envelope
		// never appear in the bundle.
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('rawStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('textBodyStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('htmlBodyStorageId');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretCiphertext');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretIv');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretAuthTag');

		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-ciphertext');
		expect(serialized).not.toContain('super-secret-iv');
		expect(serialized).not.toContain('super-secret-tag');
	});

	it('returns empty personal-data sections when the caller owns no mail or chat', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await t.query(api.auth.accountManagement.exportUserData, {
			userId: 'auth-user-1',
		});

		expect(res.personalData.mailboxes).toHaveLength(0);
		expect(res.personalData.mailMessages).toHaveLength(0);
		expect(res.personalData.mailDrafts).toHaveLength(0);
		expect(res.personalData.externalMailAccounts).toHaveLength(0);
		expect(res.personalData.chatMessages).toHaveLength(0);
	});
});

// ============================================================
// account-deletion path — non-owner member
// ============================================================

describe('accountManagement.deleteAccountForRequest — non-owner member', () => {
	it('erases auth-side rows + onboarding + profile and hands off member erasure', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		// Onboarding row keyed by BetterAuth userId.
		await t.run(async (ctx) => {
			await ctx.db.insert('onboardingProgress', {
				userId: 'auth-user-1',
				dismissed: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				// Past its grace period so the cron picks it up.
				scheduledForDeletion: Date.now() - 1000,
				cancellationToken: 'tok',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Drive the real cron entry point (a proper mutation that wraps
		// deleteAccountForRequest in a transaction + schedules erasure).
		const result = await t.mutation(internal.auth.accountDeletion.processPendingDeletions, {});
		expect(result.processedCount).toBe(1);

		await t.run(async (ctx) => {
			// Profile + onboarding gone.
			expect(await ctx.db.get(profileId)).toBeNull();
			const onboarding = await ctx.db
				.query('onboardingProgress')
				.withIndex('by_user', (q) => q.eq('userId', 'auth-user-1'))
				.collect();
			expect(onboarding).toHaveLength(0);
		});

		// BetterAuth membership row was deleted.
		const remainingMembers = (await t.query(components.betterAuth.adapter.findMany, {
			model: 'member',
			where: [{ field: 'userId', value: 'auth-user-1' }],
			paginationOpts: { cursor: null, numItems: 100 },
		} as never)) as { page: unknown[] };
		expect(remainingMembers.page).toHaveLength(0);

		// Request is NOT yet completed: the batched member-erasure walk owns that
		// transition (it was scheduled, not run inline). Still pending here.
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('pending');
		});

		// Run the member-erasure walk the cron handed off to. This member owns no
		// personal data, so it terminates in one hop, marking the request done.
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'auth-user-1',
			requestId,
		});
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});
});

// ============================================================
// member-erasure batched walk (auth/memberErasure.ts)
// ============================================================

describe('memberErasure.eraseMemberData', () => {
	/** Drive the self-rescheduling walk to completion deterministically. */
	async function drainWalk(
		t: TestConvex<typeof schema>,
		authUserId: string,
		requestId: Id<'accountDeletionRequests'>,
	): Promise<void> {
		// Bounded loop — every hop either deletes a batch (and reschedules) or
		// reaches phase 4. A handful of hops covers the seeded data.
		for (let i = 0; i < 20; i++) {
			await t.mutation(internal.auth.memberErasure.eraseMemberData, {
				authUserId,
				requestId,
			});
			const done = await t.run(async (ctx) => {
				const r = await ctx.db.get(requestId);
				return r?.status === 'completed';
			});
			if (done) return;
		}
		throw new Error('member-erasure walk did not terminate within hop budget');
	}

	it('erases the mailbox + app passwords, external creds, chat authorship and completes the request', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-2';
		const profileId = await seedProfile(t, authUserId, 'member@example.com');

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'member@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok2',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Seed the personal mailbox (+ one message with real storage blobs), an
		// app password keyed to the mailbox, an external IMAP account with a
		// folder-sync row, a user-keyed app password, and chat authorship — both
		// the member's own messages and another author's.
		const { mailboxId, otherAuthorMessageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: authUserId,
				organizationId: 'org-x',
				address: 'member@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});

			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['member@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m1@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['member@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
				rawStorageId,
				rawSize: 13,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});

			// App password keyed to the mailbox.
			await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: authUserId,
				label: 'iPhone',
				passwordHash: 'salt:hash',
				passwordPrefix: 'abcd',
				scopes: ['imap' as const],
				createdAt: now,
			});

			// External IMAP account + folder-sync row.
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: authUserId,
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'member@example.com',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('externalMailFolderSync', {
				accountId,
				mailboxId,
				folderId,
				remoteName: 'INBOX',
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: now,
			});

			// Chat: a room with the member's own message + another author's.
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: authUserId,
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: authUserId,
				text: 'mine',
				createdAt: now,
			});
			const otherAuthorMessageId = await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'theirs',
				createdAt: now,
			});
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId: authUserId,
				role: 'member' as const,
				joinedAt: now,
				lastReadAt: now,
			});

			return { mailboxId, otherAuthorMessageId };
		});

		await drainWalk(t, authUserId, requestId);

		await t.run(async (ctx) => {
			// Mailbox + its message gone.
			expect(await ctx.db.get(mailboxId)).toBeNull();
			const messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(messages).toHaveLength(0);

			// App passwords (mailbox- and user-keyed) gone.
			const appPasswords = await ctx.db
				.query('mailAppPasswords')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(appPasswords).toHaveLength(0);

			// External credentials + sync rows gone.
			const externalAccounts = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(externalAccounts).toHaveLength(0);

			// Chat: the member's authorship is anonymized; others are untouched.
			const authored = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', authUserId))
				.collect();
			expect(authored).toHaveLength(0);
			const anonymized = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', '[deleted account]'))
				.collect();
			expect(anonymized).toHaveLength(1);
			expect(anonymized[0]!.text).toBe('mine');

			// Another author's message is unchanged.
			const other = await ctx.db.get(otherAuthorMessageId);
			expect(other?.authorId).toBe('someone-else');

			// Room membership dropped.
			const memberships = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_member', (q) => q.eq('memberId', authUserId))
				.collect();
			expect(memberships).toHaveLength(0);

			// Request marked completed — the walk terminated.
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});

	it('is a clean no-op (still completes the request) when the member owns no personal data', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-3';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok3',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId,
			requestId,
		});

		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});
});
