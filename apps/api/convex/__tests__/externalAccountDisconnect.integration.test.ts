/**
 * Disconnecting a connected mailbox — what the member is actually promised.
 *
 * Three promises, one test apiece, because each of them used to be false:
 *   1. "Disconnect" forgets the password. The row kept its sealed envelope
 *      forever; only a full purge removed it.
 *   2. Disconnecting stops an import. A migration left `importing` reported a
 *      running import at a percentage that could never move, and resumed the
 *      moment the same account came back.
 *   3. "Your imported mail is kept" survives a reconnect. The connect dup-check
 *      only sees ACTIVE mailboxes, so reconnecting minted a second mailbox on
 *      the same address and left every retained message in a row no screen
 *      could reach.
 *
 * Plus the purge: it has to take the credentials INTO the mailbox (app
 * passwords) and the access rows with it, or "delete everything" is a claim
 * about messages only.
 *
 * Session mocking mirrors `externalAccounts.integration.test.ts`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { takeLiveSeedAccounts } from '../mail/external/accountShared';

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

describe('disconnect', () => {
	it('forgets the stored password', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { externalAccountId } = await t.mutation(
			internal.mail.external.accounts._connectInternal,
			CREDS
		);

		await t.mutation(api.mail.external.accounts.disconnect, {});

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.status).toBe('disconnected');
		expect(account?.secretCiphertext).toBeUndefined();
		expect(account?.secretIv).toBeUndefined();
		expect(account?.secretAuthTag).toBeUndefined();
		expect(account?.secretEnvelopeVersion).toBeUndefined();
	});

	it('leaves the mail-sync worker nothing to connect with', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { externalAccountId } = await t.mutation(
			internal.mail.external.accounts._connectInternal,
			CREDS
		);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		const credentials = await t.action(
			internal.mail.external.accountsActions.getCredentialsForWorker,
			{ accountId: externalAccountId }
		);
		// Terminal, not "missing": the worker stops rather than retrying an answer
		// only the member can change by reconnecting.
		expect(credentials).toEqual({ kind: 'unavailable', reason: 'disconnected' });
	});

	it('cancels an import that is still running', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.migration.start, { source: 'imap' });
		expect((await t.query(api.mail.migration.getStatus, {}))?.status).toBe('importing');

		const result = await t.mutation(api.mail.external.accounts.disconnect, {});

		expect(result.cancelledMigration).toBe(true);
		const migration = await t.run((ctx) => ctx.db.query('mailboxMigrations').first());
		expect(migration?.status).toBe('cancelled');
	});

	it('is idempotent once nothing is connected', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		await expect(t.mutation(api.mail.external.accounts.disconnect, {})).resolves.toEqual({
			ok: true,
			cancelledMigration: false,
		});
	});

	it('reports the mailbox it kept, so it can be reconnected or deleted', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		const result = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(result.configured).toBe(false);
		expect(result.retained?.emailAddress).toBe('me@example.com');
		expect(result.retained?.imapUsername).toBe('me@example.com');
	});
});

describe('reconnecting the same address', () => {
	it('re-opens the mailbox it kept instead of starting a second one', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const first = await connectWithMail(t);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		const again = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			secretCiphertext: 'bmV3LWNpcGhlcg==',
		});

		expect(again.mailboxId).toBe(first.mailboxId);
		expect(again.externalAccountId).toBe(first.externalAccountId);
		const mailboxes = await t.run((ctx) => ctx.db.query('mailboxes').collect());
		expect(mailboxes).toHaveLength(1);
		const mailbox = await t.run((ctx) => ctx.db.get(first.mailboxId));
		expect(mailbox?.status).toBe('active');
		// The retained message is back in a mailbox the inbox will render.
		const message = await t.run((ctx) => ctx.db.get(first.messageId));
		expect(message?.mailboxId).toBe(first.mailboxId);
		// Re-entered credentials, and a status the worker will pick up again.
		const account = await t.run((ctx) => ctx.db.get(first.externalAccountId));
		expect(account?.status).toBe('pending');
		expect(account?.secretCiphertext).toBe('bmV3LWNpcGhlcg==');
	});

	it('still provisions a fresh mailbox for a DIFFERENT address', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const first = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		const other = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'other@example.com',
			imapUsername: 'other@example.com',
		});

		expect(other.mailboxId).not.toBe(first.mailboxId);
	});

	it('never re-opens a mailbox belonging to someone else', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const first = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		setSession('user-B', 'owner');
		const second = await t.mutation(internal.mail.external.accounts._connectInternal, CREDS);

		expect(second.mailboxId).not.toBe(first.mailboxId);
		const stranded = await t.run((ctx) => ctx.db.get(first.mailboxId));
		expect(stranded?.status).toBe('deleted');
	});
});

describe('purge', () => {
	it('takes the mail, the app passwords and the access rows with it', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId, externalAccountId, messageId } = await connectWithMail(t);
		await t.mutation(api.mail.migration.start, { source: 'imap' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-A',
				label: 'Thunderbird',
				passwordHash: 'salt:hash',
				passwordPrefix: 'abcd',
				scopes: ['imap', 'smtp'],
				createdAt: Date.now(),
			});
		});

		await drainPurge(t);

		const remaining = await t.run(async (ctx) => ({
			mailbox: await ctx.db.get(mailboxId),
			account: await ctx.db.get(externalAccountId),
			message: await ctx.db.get(messageId),
			appPasswords: await ctx.db.query('mailAppPasswords').collect(),
			members: await ctx.db.query('mailboxMembers').collect(),
			migrations: await ctx.db.query('mailboxMigrations').collect(),
		}));
		expect(remaining.mailbox).toBeNull();
		expect(remaining.account).toBeNull();
		expect(remaining.message).toBeNull();
		expect(remaining.appPasswords).toEqual([]);
		expect(remaining.members).toEqual([]);
		expect(remaining.migrations).toEqual([]);
	});

	it('works on the mailbox a disconnect left behind', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId } = await connectWithMail(t);
		await t.mutation(api.mail.external.accounts.disconnect, {});

		await drainPurge(t);

		expect(await t.run((ctx) => ctx.db.get(mailboxId))).toBeNull();
		const result = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(result.configured).toBe(false);
		expect(result.retained).toBeUndefined();
	});
});
