/**
 * Teardown edges — the states the happy path does not reach.
 *
 * Every case here is one where two pieces of the lifecycle have to agree and
 * previously did not: which disconnected row a purge deletes versus the one the
 * card names, what the cascade is allowed to touch beyond its own mailbox,
 * which soft-deleted mailboxes a reconnect may re-open, and who is allowed to
 * move an account out of `disconnected` (the worker is not). Plus the seed
 * mailbox lifecycle, which shares the same teardown.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { takeLiveSeedAccounts } from '../mail/external/accountShared';
import { stopExternalAccountSync } from '../mail/external/accountTeardown';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		getUserIdFromSession: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return s.userId;
		}),
		getMutationContext: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role, activeOrganizationId: s.activeOrganizationId };
		}),
		// The admin floor resolves through the same per-test session. `adminMutation`
		// and `_connectSeedInternal` both call this one, and the real implementation
		// reaches for a BetterAuth identity no convex-test run has.
		requireAdminContext: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role, activeOrganizationId: s.activeOrganizationId };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role };
		}),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { subject: s.userId, issuer: 'test', tokenIdentifier: `test|${s.userId}` };
		}),
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
			!path.includes('llmProvider')
	)
);

const CREDS = {
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	authMethod: 'password' as const,
	secretCiphertext: 'ZmFrZS1jaXBoZXI=',
	secretIv: 'ZmFrZS1pdg==',
	secretAuthTag: 'ZmFrZS10YWc=',
	secretEnvelopeVersion: 1,
};

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

async function enableExternal(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: Date.now(),
		});
	});
}

/**
 * Run the purge and let its cascade finish. `_purgeChunk` is scheduled with
 * `runAfter(0)`, which only fires on a macrotask, so the chain has to be pumped
 * under fake timers — one millisecond per pump, as everywhere else in this suite
 * family.
 */
async function drainPurge(t: ReturnType<typeof convexTest>) {
	vi.useFakeTimers();
	try {
		await t.mutation(api.mail.external.accounts.purge, {});
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
	} finally {
		vi.useRealTimers();
	}
}

/**
 * A connected mailbox with one synced message in it.
 *
 * Typed against THIS schema (the bare `ReturnType<typeof convexTest>` erases it
 * and leaves `ctx.db` holding only the system tables), so the fixture rows below
 * are checked against the real table definitions.
 */
async function connectWithMail(t: TestConvex<typeof schema>) {
	const connected = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
	const messageId = await t.run(async (ctx) => {
		const now = Date.now();
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', connected.mailboxId))
			.first();
		if (!folder) throw new Error('the connect should have provisioned system folders');
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: connected.mailboxId,
			normalizedSubject: 'kept',
			participants: ['me@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'kept',
			latestFromAddress: 'friend@example.com',
			latestSubject: 'Kept',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
		return await ctx.db.insert('mailMessages', {
			mailboxId: connected.mailboxId,
			folderId: folder._id,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<kept@example.com>',
			threadId,
			fromAddress: 'friend@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Kept',
			normalizedSubject: 'kept',
			snippet: 'kept',
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
	});
	return { ...connected, messageId };
}

const PERSONAL_ADDRESS = 'me@example.com';

/** A second, unrelated mailbox with its own app password, member and migration. */
async function bystanderMailbox(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-B',
			organizationId: 'org-1',
			address: 'bystander@example.com',
			domain: 'example.com',
			kind: 'hosted',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const appPasswordId = await ctx.db.insert('mailAppPasswords', {
			mailboxId,
			userId: 'user-B',
			label: 'Thunderbird',
			passwordHash: 'salt:hash',
			passwordPrefix: 'wxyz',
			scopes: ['imap'],
			createdAt: now,
		});
		const memberId = await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'user-B',
			role: 'owner',
			addedBy: 'user-B',
			createdAt: now,
		});
		return { mailboxId, appPasswordId, memberId };
	});
}

describe('which mailbox a purge deletes', () => {
	it('deletes the one the card names, not whichever row is newest', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		// Disconnect `me@`, connect and disconnect a second address, then reconnect
		// and disconnect `me@` again: two disconnected personal rows, and the one
		// `getForCurrentUser` reports is the one touched last.
		const first = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});
		const second = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'other@example.com',
			imapUsername: 'other@example.com',
		});
		await t.mutation(api.mail.external.accounts.disconnect, {});
		await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		const retained = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(retained.retained?.emailAddress).toBe(PERSONAL_ADDRESS);

		await drainPurge(t);

		const state = await t.run(async (ctx) => ({
			named: await ctx.db.get(first.mailboxId),
			other: await ctx.db.get(second.mailboxId),
		}));
		expect(state.named).toBeNull();
		expect(state.other).not.toBeNull();
	});

	it('refuses to reach the read-only archive a completed move left behind', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const moved = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		// The shape `mailboxMove.archive` leaves: account disconnected, mailbox
		// deliberately still ACTIVE so the moved history stays readable.
		await t.run(async (ctx) => {
			const account = await ctx.db.get(moved.externalAccountId);
			if (!account) throw new Error('fixture');
			await stopExternalAccountSync(ctx, account, { now: Date.now(), reason: 'move' });
		});

		await expect(t.mutation(api.mail.external.accounts.purge, {})).rejects.toThrow(/not found/i);
		const archive = await t.run((ctx) => ctx.db.get(moved.mailboxId));
		expect(archive?.status).toBe('active');
	});

	it('leaves the data of every other mailbox alone', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await connectWithMail(t);
		const bystander = await bystanderMailbox(t);

		await drainPurge(t);

		const survived = await t.run(async (ctx) => ({
			mailbox: await ctx.db.get(bystander.mailboxId),
			appPassword: await ctx.db.get(bystander.appPasswordId),
			member: await ctx.db.get(bystander.memberId),
		}));
		expect(survived.mailbox).not.toBeNull();
		expect(survived.appPassword).not.toBeNull();
		expect(survived.member).not.toBeNull();
	});
});

describe('which mailboxes a reconnect may re-open', () => {
	it('will not undo an admin removal', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const removed = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.mailbox.identity.remove, { mailboxId: removed.mailboxId });

		// The owner may connect the address again — they just get a fresh mailbox,
		// exactly as they did before re-attach existed.
		const again = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		expect(again.mailboxId).not.toBe(removed.mailboxId);
		const retired = await t.run((ctx) => ctx.db.get(removed.mailboxId));
		expect(retired?.status).toBe('deleted');
		// And the removal took the password with it.
		const retiredAccount = await t.run((ctx) => ctx.db.get(removed.externalAccountId));
		expect(retiredAccount?.secretCiphertext).toBeUndefined();
		expect(retiredAccount?.adminRetiredAt).toBeTypeOf('number');
	});

	it('still lets the owner delete what an admin removal left behind', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId, messageId } = await connectWithMail(t);
		await t.mutation(api.mail.mailbox.identity.remove, { mailboxId });

		// The card says so plainly: reconnecting gives a fresh mailbox, and this
		// one's mail is the owner's to delete.
		const view = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(view.retained?.canReattach).toBe(false);

		await drainPurge(t);

		const gone = await t.run(async (ctx) => ({
			mailbox: await ctx.db.get(mailboxId),
			message: await ctx.db.get(messageId),
		}));
		expect(gone.mailbox).toBeNull();
		expect(gone.message).toBeNull();
	});

	it('will not re-open a mailbox a purge is still draining', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const purging = await connectWithMail(t);
		// Start the purge but do NOT let the cascade run: this is the window the
		// rows are still there and would otherwise look like kept mail.
		await t.mutation(api.mail.external.accounts.purge, {});

		const view = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(view.configured).toBe(false);
		expect(view.retained).toBeUndefined();

		const again = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		expect(again.mailboxId).not.toBe(purging.mailboxId);
	});

	it('will not re-open a team inbox as a personal mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const shared = await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			memberUserIds: [],
		});
		await t.run(async (ctx) => {
			const account = await ctx.db.get(shared.externalAccountId);
			if (!account) throw new Error('fixture');
			await stopExternalAccountSync(ctx, account, { now: Date.now(), reason: 'member' });
		});

		const personal = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);

		expect(personal.mailboxId).not.toBe(shared.mailboxId);
		const teamInbox = await t.run((ctx) => ctx.db.get(shared.mailboxId));
		expect(teamInbox?.scope).toBe('shared');
		expect(teamInbox?.status).toBe('deleted');
	});
});

describe('who may move an account out of disconnected', () => {
	it('not the mail-sync worker', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { externalAccountId } = await t.mutation(
			internal.mail.external.accounts._connectInternal,
			CREDS
		);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		// A connection still in its backoff loop reporting on the way down.
		await t.mutation(internal.mail.external.accounts.setSyncStatus, {
			accountId: externalAccountId,
			status: 'error',
			lastError: 'credentials unavailable',
		});

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.status).toBe('disconnected');
		// Still reconnectable, which is the point: a resurrected `error` row would
		// trip the one-live-account guard and strand the mailbox for good.
		const again = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		expect(again.externalAccountId).toBe(externalAccountId);
	});
});

describe('archiving a move', () => {
	it('keeps the mailbox readable and lets a running knowledge sweep finish', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.accounts._connectInternal,
			CREDS
		);
		const migrationId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('mailboxMigrations', {
				userId: 'user-A',
				organizationId: 'org-1',
				accountId: externalAccountId,
				mailboxId,
				source: 'imap',
				status: 'indexing',
				isAiIndexingEnabled: true,
				messagesTotal: 10,
				messagesImported: 10,
				messagesIndexed: 4,
				startedAt: now,
				updatedAt: now,
			});
		});

		await t.run(async (ctx) => {
			const account = await ctx.db.get(externalAccountId);
			if (!account) throw new Error('fixture');
			await stopExternalAccountSync(ctx, account, { now: Date.now(), reason: 'move' });
		});

		const after = await t.run(async (ctx) => ({
			mailbox: await ctx.db.get(mailboxId),
			account: await ctx.db.get(externalAccountId),
			migration: await ctx.db.get(migrationId),
		}));
		// The archive stays readable; the sweep is still reading mail that landed.
		expect(after.mailbox?.status).toBe('active');
		expect(after.migration?.status).toBe('indexing');
		// The password still goes, because nothing syncs this account any more.
		expect(after.account?.status).toBe('disconnected');
		expect(after.account?.secretCiphertext).toBeUndefined();
	});
});

describe('the one-shot credential backfill (migration 0041)', () => {
	it('clears passwords left on rows disconnected before the teardown did', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const legacy = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		// The pre-teardown shape: disconnected, envelope still on the row.
		await t.run(async (ctx) => {
			await ctx.db.patch(legacy.externalAccountId, { status: 'disconnected' });
			await ctx.db.patch(legacy.mailboxId, { status: 'deleted' });
		});
		setSession('user-B', 'owner');
		const live = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'live@example.com',
			imapUsername: 'live@example.com',
		});

		const result = await t.action(
			internal.migrations['0041_forget_disconnected_credentials'].run,
			{}
		);

		expect(result.cleared).toBe(1);
		const rows = await t.run(async (ctx) => ({
			legacy: await ctx.db.get(legacy.externalAccountId),
			live: await ctx.db.get(live.externalAccountId),
		}));
		expect(rows.legacy?.secretCiphertext).toBeUndefined();
		// A connected account keeps the password it needs to stay connected.
		expect(rows.live?.secretCiphertext).toBe(CREDS.secretCiphertext);
	});
});

describe('seed mailboxes', () => {
	/** Connect a deliverability seed as the org admin. */
	async function connectSeed(t: ReturnType<typeof convexTest>, address: string) {
		return await t.mutation(internal.mail.external.accountsSeed._connectSeedInternal, {
			...CREDS,
			emailAddress: address,
			imapUsername: address,
			seedProvider: 'gmail' as const,
		});
	}

	it('frees its slot under the per-org cap and forgets its password', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('admin-A', 'owner');
		const first = await connectSeed(t, 'seed-one@example.com');
		await connectSeed(t, 'seed-two@example.com');

		await t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
			accountId: first.externalAccountId,
		});

		const state = await t.run(async (ctx) => ({
			account: await ctx.db.get(first.externalAccountId),
			mailbox: await ctx.db.get(first.mailboxId),
			live: await takeLiveSeedAccounts(ctx.db, 'org-1', 50),
			audit: await ctx.db.query('auditLogs').collect(),
		}));
		expect(state.account?.status).toBe('disconnected');
		expect(state.account?.secretCiphertext).toBeUndefined();
		expect(state.mailbox?.status).toBe('deleted');
		// The cap counts LIVE seeds, so the retired one no longer holds a slot.
		expect(state.live).toHaveLength(1);
		expect(state.audit.map((row) => row.action)).toContain('seed_mailbox.disconnected');
	});

	it('keeps the placement history that named it', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('admin-A', 'owner');
		const seed = await connectSeed(t, 'seed-one@example.com');

		await t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
			accountId: seed.externalAccountId,
		});

		expect(await t.run((ctx) => ctx.db.get(seed.externalAccountId))).not.toBeNull();
	});

	it('is idempotent, and refuses an account that is not a seed', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('admin-A', 'owner');
		const seed = await connectSeed(t, 'seed-one@example.com');
		await t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
			accountId: seed.externalAccountId,
		});
		await expect(
			t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
				accountId: seed.externalAccountId,
			})
		).resolves.toEqual({ ok: true });

		setSession('user-A', 'owner');
		const personal = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		setSession('admin-A', 'owner');
		await expect(
			t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
				accountId: personal.externalAccountId,
			})
		).rejects.toThrow(/seed/i);
	});

	it('refuses a seed belonging to another organization', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('admin-A', 'owner');
		const seed = await connectSeed(t, 'seed-one@example.com');

		setSession('admin-B', 'owner', 'org-2');
		await expect(
			t.mutation(api.mail.external.accountsSeed.disconnectSeed, {
				accountId: seed.externalAccountId,
			})
		).rejects.toThrow(/not found|seed mailbox/i);
	});
});
