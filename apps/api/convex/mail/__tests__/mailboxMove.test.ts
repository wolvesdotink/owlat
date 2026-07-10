/**
 * "Move my mailbox here" — staged full move (piece c5).
 *
 * End-to-end over a real (convex-test) datastore for the move state machine on
 * `mail/mailboxMove` (`api.mail.mailboxMove.*`):
 *   - stage transitions provisioning → cutover_pending → archived are
 *     IDEMPOTENT (re-running the current stage is a no-op) and the job is
 *     PAUSABLE/resumable;
 *   - archive demotion stops sync (external account → 'disconnected') WITHOUT
 *     data loss — the archive mailbox stays 'active' and its messages remain
 *     queryable, nothing is deleted;
 *   - hosted-mailbox provisioning is admin-only (a non-admin mover gets an
 *     in-app request surfaced instead, never a bypass);
 *   - cancel rolls a move-in-progress back cleanly (hosted mailbox torn down,
 *     external account untouched).
 *
 * The session helpers are mocked (hoisted role/user flag) exactly as the sibling
 * `sendingSwitch.test.ts` does, so both the self-auth reads and the admin gate
 * are controllable.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from './helpers';
import { resolveDeliverableMailbox } from '../mailbox';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMocks.userId, role: sessionMocks.role })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		// `provisionHosted` uses the `adminMutation` wrapper, which calls
		// `requireAdminContext` (the module-internal `getMutationContext` it wraps is
		// not reachable through the export-level mock). Gate it on the mocked role so
		// the admin path succeeds and non-admins are genuinely rejected.
		requireAdminContext: vi.fn(async () => {
			if (sessionMocks.role !== 'owner' && sessionMocks.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return { userId: sessionMocks.userId, role: sessionMocks.role };
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

/** IMAP/SMTP credentials for `_connectInternal` (ciphertext bytes are dummy). */
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

type Ctx = TestConvex<typeof schema>;

async function enableExternal(t: Ctx): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: Date.now(),
		});
	});
}

/** Connect user-A's external mailbox; return its mailbox + account ids. */
async function connectMailbox(
	t: Ctx
): Promise<{ mailboxId: Id<'mailboxes'>; accountId: Id<'externalMailAccounts'> }> {
	await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);
	return await t.run(async (ctx) => {
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', sessionMocks.userId))
			.first();
		if (!account) throw new Error('external account not created');
		return { mailboxId: account.mailboxId, accountId: account._id };
	});
}

/** Seed one queryable message into the mailbox's inbox folder. */
async function seedMessage(t: Ctx, mailboxId: Id<'mailboxes'>): Promise<Id<'mailMessages'>> {
	return await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.filter((q) => q.eq(q.field('mailboxId'), mailboxId))
			.filter((q) => q.eq(q.field('role'), 'inbox'))
			.first();
		if (!folder) throw new Error('inbox folder missing');
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hello',
			participants: ['someone@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'hi',
			latestFromAddress: 'someone@example.com',
			latestSubject: 'hello',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		return await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: folder._id,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m1@example.com>',
			threadId,
			fromAddress: 'someone@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'hello',
			normalizedSubject: 'hello',
			snippet: 'hi',
			rawStorageId,
			rawSize: 3,
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
}

async function countOpenRequests(t: Ctx): Promise<number> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailboxRequests')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', sessionMocks.userId))
			.filter((q) => q.eq(q.field('status'), 'open'))
			.collect();
		return rows.length;
	});
}

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

describe('start — begins a move, idempotently', () => {
	it('a non-admin start raises an admin provision request and waits', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);

		const res = await t.mutation(api.mail.mailboxMove.start, {});
		expect(res.stage).toBe('provisioning');
		expect(await countOpenRequests(t)).toBe(1);

		const status = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(status.eligible).toBe(true);
		if (!status.eligible) return;
		expect(status.canProvisionSelf).toBe(false);
		expect(status.move?.stage).toBe('provisioning');
		expect(status.move?.awaitingAdminProvision).toBe(true);
	});

	it('re-starting is a no-op — same move, no duplicate request', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);

		const first = await t.mutation(api.mail.mailboxMove.start, {});
		const second = await t.mutation(api.mail.mailboxMove.start, {});
		expect(second.moveId).toBe(first.moveId);
		expect(await countOpenRequests(t)).toBe(1);
	});

	it('an admin start needs no request and can self-provision', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.role = 'admin';
		await enableExternal(t);
		await connectMailbox(t);

		await t.mutation(api.mail.mailboxMove.start, {});
		expect(await countOpenRequests(t)).toBe(0);

		const status = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(status.eligible).toBe(true);
		if (!status.eligible) return;
		expect(status.canProvisionSelf).toBe(true);
		expect(status.move?.awaitingAdminProvision).toBe(false);
	});
});

describe('provisionHosted — admin-only provisioning → cutover_pending', () => {
	it('provisions a hosted mailbox on the same address and resolves the request', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		const { mailboxId } = await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		expect(await countOpenRequests(t)).toBe(1);

		sessionMocks.role = 'admin';
		const res = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		expect(res.stage).toBe('cutover_pending');
		expect(res.hostedMailboxId).not.toBe(mailboxId);
		// The admin request that surfaced the move is resolved.
		expect(await countOpenRequests(t)).toBe(0);

		// A distinct hosted mailbox now exists on the same address.
		await t.run(async (ctx) => {
			const hosted = await ctx.db.get(res.hostedMailboxId);
			expect(hosted?.kind).toBe('hosted');
			expect(hosted?.address).toBe('me@example.com');
		});
	});

	it('provisioning is idempotent — a second call returns the same hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});

		sessionMocks.role = 'admin';
		const first = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		const second = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		expect(second.hostedMailboxId).toBe(first.hostedMailboxId);
		expect(second.stage).toBe('cutover_pending');
	});

	it('a non-admin cannot provision (gate not bypassed)', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});

		// still editor
		await expect(t.mutation(api.mail.mailboxMove.provisionHosted, { moveId })).rejects.toThrow();
	});
});

describe('archive — stops sync without data loss', () => {
	async function provisioned(t: Ctx): Promise<{
		accountId: Id<'externalMailAccounts'>;
		mailboxId: Id<'mailboxes'>;
		messageId: Id<'mailMessages'>;
	}> {
		await enableExternal(t);
		const { mailboxId, accountId } = await connectMailbox(t);
		const messageId = await seedMessage(t, mailboxId);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		return { accountId, mailboxId, messageId };
	}

	it('demotes the external account to a read-only archive; history stays queryable', async () => {
		const t = convexTest(schema, modules);
		const { accountId, mailboxId, messageId } = await provisioned(t);

		const res = await t.mutation(api.mail.mailboxMove.archive, {});
		expect(res.stage).toBe('archived');

		await t.run(async (ctx) => {
			// Sync stopped: the worker skips 'disconnected' accounts.
			const account = await ctx.db.get(accountId);
			expect(account?.status).toBe('disconnected');
			// Archive mailbox stays active (readable) — NOT deleted.
			const mailbox = await ctx.db.get(mailboxId);
			expect(mailbox?.status).toBe('active');
			// The message is still there.
			const message = await ctx.db.get(messageId);
			expect(message).not.toBeNull();
			expect(message?.mailboxId).toBe(mailboxId);
		});
	});

	it('moveStatus keeps surfacing the archived move after the account is demoted', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await provisioned(t);
		const res = await t.mutation(api.mail.mailboxMove.archive, {});
		expect(res.stage).toBe('archived');

		// The live external mailbox is gone (account 'disconnected'), but the flow
		// must still show its terminal truth — not self-hide the whole section.
		const status = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(status.eligible).toBe(true);
		if (!status.eligible) throw new Error('expected eligible');
		expect(status.move?.stage).toBe('archived');
		expect(status.move?.archivedAt).not.toBeNull();
		expect(status.address).toBeTruthy();
		expect(status.accountStatus).toBe('disconnected');
		// The archive mailbox stays readable.
		await t.run(async (ctx) => {
			const mailbox = await ctx.db.get(mailboxId);
			expect(mailbox?.status).toBe('active');
		});
	});

	it('a completed move does not shadow a fresh move on a newly-connected account', async () => {
		const t = convexTest(schema, modules);
		await provisioned(t); // move on me@example.com, provisioned + about to archive
		await t.mutation(api.mail.mailboxMove.archive, {});

		// The old account is now 'disconnected', so connecting a second external
		// account on a DIFFERENT address is allowed.
		await t.mutation(internal.mail.externalAccounts._connectInternal, {
			...CREDS,
			emailAddress: 'other@example.org',
			imapUsername: 'other@example.org',
		});

		// moveStatus must pair the move with the live account, not the caller's
		// oldest (archived) row: the new address shows the "start a move" pitch,
		// with no move and the address that actually lives on the external account.
		const status = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(status.eligible).toBe(true);
		if (!status.eligible) throw new Error('expected eligible');
		expect(status.address).toBe('other@example.org');
		expect(status.move).toBeNull();

		// A fresh start is reachable — it creates a move on the new account, and
		// moveStatus/requireCallerMove now surface THAT move, not the archived one.
		const started = await t.mutation(api.mail.mailboxMove.start, {});
		expect(started.stage).toBe('provisioning');
		const after = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(after.eligible).toBe(true);
		if (!after.eligible) throw new Error('expected eligible');
		expect(after.address).toBe('other@example.org');
		expect(after.move?.id).toBe(started.moveId);
		expect(after.move?.stage).toBe('provisioning');
	});

	it('archiving is idempotent', async () => {
		const t = convexTest(schema, modules);
		await provisioned(t);
		const first = await t.mutation(api.mail.mailboxMove.archive, {});
		const second = await t.mutation(api.mail.mailboxMove.archive, {});
		expect(first.stage).toBe('archived');
		expect(second.stage).toBe('archived');
	});

	it('refuses to archive before a hosted mailbox is provisioned', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);
		await t.mutation(api.mail.mailboxMove.start, {}); // stage 'provisioning'
		await expect(t.mutation(api.mail.mailboxMove.archive, {})).rejects.toThrow();
	});
});

describe('pause / resume — the job is pausable', () => {
	it('pauses and resumes idempotently', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);
		await t.mutation(api.mail.mailboxMove.start, {});

		expect((await t.mutation(api.mail.mailboxMove.pause, {})).isPaused).toBe(true);
		expect((await t.mutation(api.mail.mailboxMove.pause, {})).isPaused).toBe(true);
		const status = await t.query(api.mail.mailboxMove.moveStatus, {});
		expect(status.eligible && status.move?.isPaused).toBe(true);

		expect((await t.mutation(api.mail.mailboxMove.resume, {})).isPaused).toBe(false);
		expect((await t.mutation(api.mail.mailboxMove.resume, {})).isPaused).toBe(false);
	});
});

describe('cancel — clean rollback before archive', () => {
	it('tears down the hosted mailbox and leaves the external account untouched', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		const { accountId } = await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		const { hostedMailboxId } = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';

		const res = await t.mutation(api.mail.mailboxMove.cancel, {});
		expect(res.cancelled).toBe(true);

		await t.run(async (ctx) => {
			// Hosted mailbox soft-deleted.
			const hosted = await ctx.db.get(hostedMailboxId);
			expect(hosted?.status).toBe('deleted');
			// External account still live — rollback lost nothing.
			const account = await ctx.db.get(accountId);
			expect(account?.status).toBe('pending');
			// Move row gone.
			const move = await ctx.db
				.query('mailboxMoves')
				.withIndex('by_user', (q) => q.eq('userId', 'user-A'))
				.first();
			expect(move).toBeNull();
		});
	});

	it('refuses to cancel an already-archived move', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		const { mailboxId } = await connectMailbox(t);
		await seedMessage(t, mailboxId);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		await t.mutation(api.mail.mailboxMove.archive, {});

		await expect(t.mutation(api.mail.mailboxMove.cancel, {})).rejects.toThrow();
	});

	it('refuses the clean rollback once mail has landed in the hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		const { hostedMailboxId } = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		// MX already cut over: real inbound mail is now in the hosted mailbox.
		await seedMessage(t, hostedMailboxId);

		await expect(t.mutation(api.mail.mailboxMove.cancel, {})).rejects.toThrow();

		// Nothing orphaned: the hosted mailbox and the move both survive.
		await t.run(async (ctx) => {
			const hosted = await ctx.db.get(hostedMailboxId);
			expect(hosted?.status).toBe('active');
			const move = await ctx.db
				.query('mailboxMoves')
				.withIndex('by_user', (q) => q.eq('userId', 'user-A'))
				.first();
			expect(move).not.toBeNull();
		});
	});
});

describe('routing — post-archive inbound resolves to the hosted mailbox', () => {
	it('resolves the live hosted mailbox, not the external archive, on the shared address', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		const { mailboxId: externalMailboxId } = await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		const { hostedMailboxId } = await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		await t.mutation(api.mail.mailboxMove.archive, {});

		// After archive BOTH rows stay 'active' (the archive must remain readable),
		// so a naive by_address .first() would return the older external one. The
		// deterministic resolver inbound delivery + IMAP/SMTP auth use must return
		// the live hosted mailbox instead.
		await t.run(async (ctx) => {
			const resolved = await resolveDeliverableMailbox(ctx, 'me@example.com');
			expect(resolved?._id).toBe(hostedMailboxId);
			expect(resolved?._id).not.toBe(externalMailboxId);
			expect(resolved?.kind).toBe('hosted');
		});
	});
});

describe('externalAccounts resolves the LIVE account after a move + reconnect', () => {
	/** Provision + archive a move on me@example.com, then connect a second live
	 * account on other@example.org. Returns both accounts' ids and the archive's
	 * mailbox + message so a test can assert the archive is left untouched. */
	async function movedThenReconnected(t: Ctx): Promise<{
		archiveAccountId: Id<'externalMailAccounts'>;
		archiveMailboxId: Id<'mailboxes'>;
		archiveMessageId: Id<'mailMessages'>;
		liveAccountId: Id<'externalMailAccounts'>;
		liveMailboxId: Id<'mailboxes'>;
	}> {
		await enableExternal(t);
		const { mailboxId: archiveMailboxId, accountId: archiveAccountId } = await connectMailbox(t);
		const archiveMessageId = await seedMessage(t, archiveMailboxId);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		await t.mutation(api.mail.mailboxMove.archive, {});

		// The old account is 'disconnected'; connect a second, LIVE account.
		await t.mutation(internal.mail.externalAccounts._connectInternal, {
			...CREDS,
			emailAddress: 'other@example.org',
			imapUsername: 'other@example.org',
		});
		const live = await t.run(async (ctx) => {
			const account = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', sessionMocks.userId))
				.filter((q) => q.neq(q.field('_id'), archiveAccountId))
				.first();
			if (!account) throw new Error('live account not created');
			return { liveAccountId: account._id, liveMailboxId: account.mailboxId };
		});
		return { archiveAccountId, archiveMailboxId, archiveMessageId, ...live };
	}

	it('purge drains the live account and leaves the archive mailbox intact', async () => {
		const t = convexTest(schema, modules);
		const { archiveAccountId, archiveMailboxId, archiveMessageId, liveAccountId, liveMailboxId } =
			await movedThenReconnected(t);

		// purge targets the LIVE account (the one the migrate page renders for), NOT
		// the caller's oldest row (the archive) — the archive's history is never deleted.
		// purge schedules a runAfter(0) `_purgeChunk` drain; fake timers + runAllTimers
		// is convex-test's pattern for chained scheduled functions (finishInProgress
		// only awaits callbacks that have already fired, so the chunk never runs).
		vi.useFakeTimers();
		try {
			await t.mutation(api.mail.externalAccounts.purge, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			// The live account + its mailbox are gone (purged).
			expect(await ctx.db.get(liveAccountId)).toBeNull();
			expect(await ctx.db.get(liveMailboxId)).toBeNull();
			// The archive account stays 'disconnected' and its mailbox stays 'active'
			// with its message intact — "history stays, nothing is deleted".
			const archiveAccount = await ctx.db.get(archiveAccountId);
			expect(archiveAccount?.status).toBe('disconnected');
			const archiveMailbox = await ctx.db.get(archiveMailboxId);
			expect(archiveMailbox?.status).toBe('active');
			const message = await ctx.db.get(archiveMessageId);
			expect(message).not.toBeNull();
			expect(message?.mailboxId).toBe(archiveMailboxId);
		});
	});

	it('re-entering credentials patches the live account, never the archive', async () => {
		const t = convexTest(schema, modules);
		const { archiveAccountId, liveAccountId } = await movedThenReconnected(t);

		// Re-enter credentials (as the migrate page's edit form does, pre-filled from
		// the live account) with a changed host.
		await t.mutation(internal.mail.externalAccounts._updateCredentialsInternal, {
			...CREDS,
			emailAddress: 'other@example.org',
			imapUsername: 'other@example.org',
			imapHost: 'imap.changed.example',
		});

		await t.run(async (ctx) => {
			// The LIVE account got the new host + a 'pending' re-validation.
			const live = await ctx.db.get(liveAccountId);
			expect(live?.imapHost).toBe('imap.changed.example');
			expect(live?.status).toBe('pending');
			// The ARCHIVE account is untouched — no resumed sync into read-only history.
			const archive = await ctx.db.get(archiveAccountId);
			expect(archive?.imapHost).toBe(CREDS.imapHost);
			expect(archive?.status).toBe('disconnected');
		});
	});

	it('re-entering credentials with no live account is a not-found', async () => {
		const t = convexTest(schema, modules);
		// Archive a move but do NOT reconnect — only a disconnected archive remains.
		await enableExternal(t);
		await connectMailbox(t);
		const { moveId } = await t.mutation(api.mail.mailboxMove.start, {});
		sessionMocks.role = 'admin';
		await t.mutation(api.mail.mailboxMove.provisionHosted, { moveId });
		sessionMocks.role = 'editor';
		await t.mutation(api.mail.mailboxMove.archive, {});

		// Re-entering credentials for an archive is meaningless — reconnect is the path.
		await expect(
			t.mutation(internal.mail.externalAccounts._updateCredentialsInternal, CREDS)
		).rejects.toThrow();
	});
});
