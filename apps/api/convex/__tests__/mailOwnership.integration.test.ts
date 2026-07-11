/**
 * Per-user mailbox ownership in the Postbox (`mail/*`).
 *
 * The single-org deployment shares one organization, so the security boundary
 * for personal mail is NOT org-id filtering — it is PER-USER ownership,
 * enforced by `requireMailboxAccess` / `requireMessageAccess` (mail/permissions.ts):
 *   - role 'owner'/'admin' can act on any user's mailbox (org-admin override);
 *   - role 'editor' can act only on a mailbox whose `userId` equals theirs.
 *
 * These tests drive the boundary through the PUBLIC mutations/queries (drafts,
 * folders, labels, filters, messageActions, snooze) with two `editor` users —
 * Alice owns mailbox A, Bob owns mailbox B — and assert that each user can act
 * on their own mailbox/message/draft/folder while the other is denied.
 *
 * Also covered:
 *   - drafts.send / cancelPendingSend ownership;
 *   - the snooze/unsnooze + setFlags counter math against `folder.unseenCount`
 *     (snoozed unread messages are NOT counted; unsnooze mirrors the snooze
 *     decrement);
 *   - folder/label/filter create cross-mailbox-target rejection.
 *
 * Session mocking: mail reads the session via `getBetterAuthSessionWithRole`
 * (inside `requireMailboxAccess`); the `authedMutation`/`authedQuery` wrappers floor
 * on `getMutationContext` / `requireOrgMember`. All of these are routed through
 * one mutable hoisted session so `setUser(...)` flips the acting identity.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// Mutable session — `setUser` flips who the request is acting as.
const sessionMock = vi.hoisted(() => ({
	user: {
		id: 'user-alice',
		role: 'editor' as 'owner' | 'admin' | 'editor',
		orgId: 'org-1',
	},
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// `requireMailboxAccess` reads ownership through this.
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
		})),
		// Wrapper floors (authedMutation / authedQuery). They only need a member;
		// route them through the same mutable session so a set user never trips
		// the floor while the in-handler ownership check does the real work.
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
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
			!path.includes('llmProvider')
	)
);

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'editor') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

beforeEach(() => {
	setUser('user-alice', 'editor');
});

// ── Seed helpers ────────────────────────────────────────────────────

type MailboxParts = {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
	trashId: Id<'mailFolders'>;
};

async function seedMailbox(
	t: TestConvex<typeof schema>,
	ownerUserId: string,
	address: string
): Promise<MailboxParts> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: ownerUserId,
			organizationId: 'org-1',
			address,
			domain: 'hinterland.camp',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (name: string, role: 'inbox' | 'archive' | 'trash') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		const inboxId = await folder('INBOX', 'inbox');
		const archiveId = await folder('Archive', 'archive');
		const trashId = await folder('Trash', 'trash');
		return { mailboxId, inboxId, archiveId, trashId };
	});
}

/** Seed a thread + message in a folder. `unread` ⇒ flagSeen=false. */
async function seedMessage(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	folderId: Id<'mailFolders'>,
	opts: { unread?: boolean; snoozedUntil?: number } = {}
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hello',
			participants: ['sender@example.com'],
			messageCount: 1,
			unreadCount: opts.unread === false ? 0 : 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'snip',
			latestFromAddress: 'sender@example.com',
			latestSubject: 'Hello',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
			threadId,
			fromAddress: 'sender@example.com',
			toAddresses: ['a@hinterland.camp'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Hello',
			normalizedSubject: 'hello',
			snippet: 'snip',
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: opts.unread === false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			snoozedUntil: opts.snoozedUntil,
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		return { messageId, threadId };
	});
}

const getFolder = (t: TestConvex<typeof schema>, folderId: Id<'mailFolders'>) =>
	t.run(async (ctx) => ctx.db.get(folderId));

// ════════════════════════════════════════════════════════════════════
// Drafts — per-user ownership of create/update/get + cross-user denial
// ════════════════════════════════════════════════════════════════════

describe('mail.drafts ownership', () => {
	it('lets the mailbox owner create + read + update their own draft', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		expect(draftId).toBeDefined();

		await t.mutation(api.mail.drafts.update, {
			draftId,
			subject: 'My subject',
			toAddresses: ['x@example.com'],
		});

		const draft = await t.query(api.mail.drafts.get, { draftId });
		expect(draft?.subject).toBe('My subject');
		expect(draft?.toAddresses).toEqual(['x@example.com']);
	});

	it('persists inReplyToMessageId for a SAME-mailbox reply', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId);

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
			inReplyToMessageId: messageId,
		});
		const draft = await t.query(api.mail.drafts.get, { draftId });
		expect(draft?.inReplyToMessageId).toBe(messageId);
	});

	it('authz-flaganswered: drops a CROSS-mailbox inReplyToMessageId on create', async () => {
		// A reply whose referenced message lives in another user's mailbox must
		// NOT persist the linkage — otherwise the send-time flagAnswered effect
		// would flip a flag in the other mailbox (cross-mailbox IDOR).
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const b = await seedMailbox(t, 'user-bob', 'bob@hinterland.camp');
		const { messageId: bobMessage } = await seedMessage(t, b.mailboxId, b.inboxId);

		// Alice creates a reply in her OWN mailbox but points it at Bob's message.
		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
			inReplyToMessageId: bobMessage,
		});
		const draft = await t.query(api.mail.drafts.get, { draftId });
		expect(draft?.inReplyToMessageId).toBeUndefined();
	});

	it('denies create on another user’s mailbox (editor, not owner)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-bob', 'editor');
		await expect(t.mutation(api.mail.drafts.create, { mailboxId: a.mailboxId })).rejects.toThrow();
	});

	it('hides another user’s draft from get and refuses update', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});

		// Bob (editor) cannot see Alice's draft, and cannot mutate it.
		setUser('user-bob', 'editor');
		const seen = await t.query(api.mail.drafts.get, { draftId });
		expect(seen).toBeNull();
		await expect(
			t.mutation(api.mail.drafts.update, { draftId, subject: 'hijacked' })
		).rejects.toThrow();

		// And the draft is unchanged.
		setUser('user-alice', 'editor');
		const draft = await t.query(api.mail.drafts.get, { draftId });
		expect(draft?.subject).toBe('');
	});

	it('listForMailbox returns the owner’s drafts but [] for a non-owner', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.drafts.create, { mailboxId: a.mailboxId });
		const own = await t.query(api.mail.drafts.listForMailbox, {
			mailboxId: a.mailboxId,
		});
		expect(own).toHaveLength(1);

		setUser('user-bob', 'editor');
		const foreign = await t.query(api.mail.drafts.listForMailbox, {
			mailboxId: a.mailboxId,
		});
		expect(foreign).toEqual([]);
	});

	it('lets an org admin act on another user’s mailbox (owner/admin override)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-carol', 'admin');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		expect(draftId).toBeDefined();
		const draft = await t.query(api.mail.drafts.get, { draftId });
		expect(draft?.mailboxId).toBe(a.mailboxId);
	});
});

// ════════════════════════════════════════════════════════════════════
// drafts.send / cancelPendingSend ownership
// ════════════════════════════════════════════════════════════════════

describe('mail.drafts.send + cancelPendingSend ownership', () => {
	it('owner can send (→ pending_send) and cancel within the undo window', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});

		const { undoToken, sendAt } = await t.mutation(api.mail.drafts.send, {
			draftId,
			undoSendDelayMs: 30_000,
		});
		expect(typeof undoToken).toBe('string');
		expect(sendAt).toBeGreaterThan(Date.now());

		const pending = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(pending?.state).toBe('pending_send');

		const cancelled = await t.mutation(api.mail.drafts.cancelPendingSend, {
			undoToken,
		});
		expect(cancelled).toEqual({ ok: true, draftId });
		const reverted = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(reverted?.state).toBe('draft');
		expect(reverted?.undoToken).toBeUndefined();
	});

	it('a non-owner cannot send another user’s draft', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});

		setUser('user-bob', 'editor');
		await expect(t.mutation(api.mail.drafts.send, { draftId })).rejects.toThrow();
	});

	it('cancelPendingSend with a valid token but wrong user is a no-op (ok:false)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});
		const { undoToken } = await t.mutation(api.mail.drafts.send, { draftId });

		// Bob holds the token (somehow) but does not own the mailbox: refused,
		// and the draft stays pending_send.
		setUser('user-bob', 'editor');
		const res = await t.mutation(api.mail.drafts.cancelPendingSend, {
			undoToken,
		});
		expect(res).toEqual({ ok: false });

		const still = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(still?.state).toBe('pending_send');
	});
});

// ════════════════════════════════════════════════════════════════════
// drafts.send — an HONEST firstSendDone (never completed without a transport)
// ════════════════════════════════════════════════════════════════════

describe('mail.drafts.send — honest firstSendDone gating', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Read the caller's onboarding `firstSendDone` stamp (null when unset).
	const readFirstSendDone = (t: TestConvex<typeof schema>, authUserId: string) =>
		t.run(async (ctx) => {
			const row = await ctx.db
				.query('userOnboarding')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
				.first();
			return row?.firstSendDone ?? null;
		});

	async function sendOwnTestDraft(
		t: TestConvex<typeof schema>,
		mailboxId: Id<'mailboxes'>
	): Promise<void> {
		const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});
		await t.mutation(api.mail.drafts.send, { draftId, undoSendDelayMs: 30_000 });
	}

	// A connected external (BYO SMTP) mailbox: kind='external' PLUS a real
	// externalMailAccounts row referenced by externalAccountId. Without the
	// account link the mailbox resolves back to the HOSTED (MTA) transport, so
	// the fixture must carry it to exercise the external branch it intends to.
	async function seedExternalMailbox(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
		return t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-ext',
				organizationId: 'org-1',
				address: 'ext@hinterland.camp',
				domain: 'hinterland.camp',
				kind: 'external',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: 'user-ext',
				organizationId: 'org-1',
				mailboxId,
				imapHost: 'imap.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password',
				imapUsername: 'ext@hinterland.camp',
				secretCiphertext: 'x',
				secretIv: 'x',
				secretAuthTag: 'x',
				secretEnvelopeVersion: 1,
				status: 'connected',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(mailboxId, { externalAccountId: accountId });
			return mailboxId;
		});
	}

	it('does NOT stamp firstSendDone when a hosted mailbox has no MTA transport', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		// Hosted Postbox drafts dispatch exclusively via the MTA. With no MTA env
		// the send is silently never dispatched, so the milestone must NOT record.
		setUser('user-alice', 'editor');
		await sendOwnTestDraft(t, a.mailboxId);

		expect(await readFirstSendDone(t, 'user-alice')).toBeNull();
	});

	it('does NOT stamp firstSendDone for a hosted mailbox on a resend-only instance (no MTA)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		// A campaign/transactional provider (resend) is configured but there is no
		// MTA — the Postbox draft is saved to Sent and never dispatched. Stamping
		// here would be the exact lie this gate exists to remove.
		vi.stubEnv('EMAIL_PROVIDER', 'resend');
		vi.stubEnv('RESEND_API_KEY', 'secret');
		setUser('user-alice', 'editor');
		await sendOwnTestDraft(t, a.mailboxId);

		expect(await readFirstSendDone(t, 'user-alice')).toBeNull();
	});

	it('stamps firstSendDone on a real send once the MTA is configured', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		// The MTA — the transport hosted Postbox drafts actually ship through — is
		// reachable, so the send honestly completes the first-send step. Keyed on
		// the MTA env, NOT EMAIL_PROVIDER (Postbox dispatch never consults it).
		vi.stubEnv('MTA_API_URL', 'https://mta.example');
		vi.stubEnv('MTA_API_KEY', 'secret');
		setUser('user-alice', 'editor');
		await sendOwnTestDraft(t, a.mailboxId);

		expect(await readFirstSendDone(t, 'user-alice')).toBeGreaterThan(0);
	});

	it('stamps firstSendDone for an external mailbox once the mail-sync worker is configured', async () => {
		const t = convexTest(schema, modules);
		// External mailbox ships through the member's own SMTP via the mail-sync
		// worker — its transport is the worker env, not the instance provider.
		const mailboxId = await seedExternalMailbox(t);

		// No instance provider, but the external worker IS configured.
		vi.stubEnv('MAIL_SYNC_API_URL', 'https://sync.example');
		vi.stubEnv('MAIL_SYNC_API_KEY', 'secret');
		setUser('user-ext', 'editor');
		await sendOwnTestDraft(t, mailboxId);

		expect(await readFirstSendDone(t, 'user-ext')).toBeGreaterThan(0);
	});

	it('does NOT stamp firstSendDone for an external mailbox when the worker is unconfigured', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedExternalMailbox(t);

		setUser('user-ext', 'editor');
		await sendOwnTestDraft(t, mailboxId);

		expect(await readFirstSendDone(t, 'user-ext')).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════
// drafts.cancelScheduledSend — unschedule a future send by draftId
// ════════════════════════════════════════════════════════════════════

describe('mail.drafts.cancelScheduledSend ownership', () => {
	it('owner can unschedule a scheduled draft → back to editable draft', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});

		const scheduledSendAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
		await t.mutation(api.mail.drafts.send, { draftId, scheduledSendAt });
		const scheduled = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(scheduled?.state).toBe('scheduled');
		expect(scheduled?.scheduledSendAt).toBe(scheduledSendAt);

		const cancelled = await t.mutation(api.mail.drafts.cancelScheduledSend, {
			draftId,
		});
		expect(cancelled).toEqual({ ok: true, draftId });

		const reverted = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(reverted?.state).toBe('draft');
		expect(reverted?.scheduledSendAt).toBeUndefined();
		expect(reverted?.undoToken).toBeUndefined();
	});

	it('unscheduling re-enables autosave: drafts.update succeeds afterwards', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});
		await t.mutation(api.mail.drafts.send, {
			draftId,
			scheduledSendAt: Date.now() + 60_000,
		});

		// While scheduled, update is rejected by the state guard.
		await expect(
			t.mutation(api.mail.drafts.update, { draftId, subject: 'edited' })
		).rejects.toThrow();

		await t.mutation(api.mail.drafts.cancelScheduledSend, { draftId });

		// After unscheduling, the autosave path works again.
		await t.mutation(api.mail.drafts.update, { draftId, subject: 'edited' });
		const edited = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(edited?.subject).toBe('edited');
	});

	it('a non-owner cannot unschedule another user’s scheduled draft', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});
		await t.mutation(api.mail.drafts.update, {
			draftId,
			toAddresses: ['recipient@example.com'],
		});
		await t.mutation(api.mail.drafts.send, {
			draftId,
			scheduledSendAt: Date.now() + 60_000,
		});

		setUser('user-bob', 'editor');
		await expect(t.mutation(api.mail.drafts.cancelScheduledSend, { draftId })).rejects.toThrow();

		const still = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(still?.state).toBe('scheduled');
	});

	it('cancelScheduledSend on a plain draft is a soft no-op (ok:false)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId: a.mailboxId,
		});

		// Never scheduled: the scheduled→draft edge is illegal from 'draft'.
		const res = await t.mutation(api.mail.drafts.cancelScheduledSend, {
			draftId,
		});
		expect(res).toEqual({ ok: false });
		const still = await t.run(async (ctx) => ctx.db.get(draftId));
		expect(still?.state).toBe('draft');
	});
});

// ════════════════════════════════════════════════════════════════════
// messageActions — ownership + unseenCount counter math
// ════════════════════════════════════════════════════════════════════

describe('mail.messageActions ownership', () => {
	it('markRead on another user’s message is silently skipped (no mutation)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		// Bob (editor) cannot mark Alice's message read. setFlags loops over
		// the ids and `continue`s on a non-owned mailbox, so it does not throw —
		// the assertion is that nothing changed.
		setUser('user-bob', 'editor');
		await t.mutation(api.mail.messageActions.markRead, { messageId, seen: true });

		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.flagSeen).toBe(false);
		const inbox = await getFolder(t, a.inboxId);
		expect(inbox?.unseenCount).toBe(0); // seeded at 0; untouched
	});

	it('archive routes another user’s message nowhere (target-folder owner gate)', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.messageActions.archive, { messageIds: [messageId] })
		).rejects.toThrow();

		// Message did not move.
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.folderId).toBe(a.inboxId);
	});

	it('owner markRead decrements the folder unseenCount by exactly one', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});
		// Make the seeded folder counter reflect the unread message.
		await t.run(async (ctx) => {
			await ctx.db.patch(a.inboxId, { unseenCount: 1 });
		});

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.messageActions.markRead, { messageId, seen: true });

		const inbox = await getFolder(t, a.inboxId);
		expect(inbox?.unseenCount).toBe(0);

		// Flipping back to unread re-adds it.
		await t.mutation(api.mail.messageActions.markRead, {
			messageId,
			seen: false,
		});
		const inbox2 = await getFolder(t, a.inboxId);
		expect(inbox2?.unseenCount).toBe(1);
	});

	it('owner setStar flips flagFlagged without touching unseenCount', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});
		await t.run(async (ctx) => ctx.db.patch(a.inboxId, { unseenCount: 1 }));

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.messageActions.setStar, {
			messageId,
			starred: true,
		});

		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.flagFlagged).toBe(true);
		const inbox = await getFolder(t, a.inboxId);
		expect(inbox?.unseenCount).toBe(1); // unchanged by a star toggle
	});

	it('owner archive moves the message to the Archive folder and migrates the counter', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(a.inboxId, { totalCount: 1, unseenCount: 1 });
		});

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.messageActions.archive, { messageIds: [messageId] });

		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.folderId).toBe(a.archiveId);

		const inbox = await getFolder(t, a.inboxId);
		expect(inbox?.unseenCount).toBe(0);
		expect(inbox?.totalCount).toBe(0);
		const archive = await getFolder(t, a.archiveId);
		expect(archive?.unseenCount).toBe(1);
		expect(archive?.totalCount).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════
// snooze / unsnooze — ownership + the unseenCount mirror
// ════════════════════════════════════════════════════════════════════

describe('mail.snooze ownership + counter math', () => {
	it('snoozing an unread message decrements unseenCount; unsnooze restores it', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});
		await t.run(async (ctx) => ctx.db.patch(a.inboxId, { unseenCount: 1 }));

		setUser('user-alice', 'editor');
		const until = Date.now() + 60 * 60 * 1000;
		await t.mutation(api.mail.snooze.snooze, { messageId, until });

		const afterSnooze = await getFolder(t, a.inboxId);
		expect(afterSnooze?.unseenCount).toBe(0); // hidden ⇒ leaves the count

		await t.mutation(api.mail.snooze.unsnooze, { messageId });
		const afterUnsnooze = await getFolder(t, a.inboxId);
		expect(afterUnsnooze?.unseenCount).toBe(1); // mirror: back in the count
	});

	it('snoozing a READ message does not change unseenCount', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: false,
		});
		// A read message contributes 0 to unseenCount.
		await t.run(async (ctx) => ctx.db.patch(a.inboxId, { unseenCount: 0 }));

		setUser('user-alice', 'editor');
		const until = Date.now() + 60 * 60 * 1000;
		await t.mutation(api.mail.snooze.snooze, { messageId, until });
		expect((await getFolder(t, a.inboxId))?.unseenCount).toBe(0);

		await t.mutation(api.mail.snooze.unsnooze, { messageId });
		expect((await getFolder(t, a.inboxId))?.unseenCount).toBe(0);
	});

	it('a seen-flip on a SNOOZED unread message must NOT touch unseenCount', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const until = Date.now() + 60 * 60 * 1000;
		// Snoozed + unread ⇒ already excluded from the count, so it starts at 0.
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
			snoozedUntil: until,
		});
		await t.run(async (ctx) => ctx.db.patch(a.inboxId, { unseenCount: 0 }));

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.messageActions.markRead, { messageId, seen: true });

		// The message is now seen, but it was snoozed: the counter is unchanged.
		expect((await getFolder(t, a.inboxId))?.unseenCount).toBe(0);
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.flagSeen).toBe(true);
	});

	it('a non-owner cannot snooze another user’s message', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.snooze.snooze, {
				messageId,
				until: Date.now() + 60_000,
			})
		).rejects.toThrow();
	});

	it('rejects a snooze time in the past', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.mail.snooze.snooze, {
				messageId,
				until: Date.now() - 1,
			})
		).rejects.toThrow();
	});
});

// ════════════════════════════════════════════════════════════════════
// Folders — ownership + same-mailbox parent target
// ════════════════════════════════════════════════════════════════════

describe('mail.folders ownership', () => {
	it('owner can create a custom folder; non-owner is denied', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const folderId = await t.mutation(api.mail.folders.create, {
			mailboxId: a.mailboxId,
			name: 'Receipts',
		});
		expect(folderId).toBeDefined();

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.folders.create, {
				mailboxId: a.mailboxId,
				name: 'Sneaky',
			})
		).rejects.toThrow();
	});

	it('rejects a parent folder that belongs to a different mailbox', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const b = await seedMailbox(t, 'user-bob', 'bob@hinterland.camp');

		// Alice owns mailbox A. A parent in mailbox B (Bob's) is invalid even
		// though Alice passes the mailbox-A ownership gate.
		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.mail.folders.create, {
				mailboxId: a.mailboxId,
				name: 'Nested',
				parentId: b.inboxId,
			})
		).rejects.toThrow();
	});

	it('folders.list returns [] for a non-owner', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const own = await t.query(api.mail.folders.list, { mailboxId: a.mailboxId });
		expect(own.length).toBeGreaterThan(0);

		setUser('user-bob', 'editor');
		const foreign = await t.query(api.mail.folders.list, {
			mailboxId: a.mailboxId,
		});
		expect(foreign).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════
// Labels — ownership + same-mailbox target on toggleOnMessage
// ════════════════════════════════════════════════════════════════════

describe('mail.labels ownership', () => {
	it('owner can create a label; non-owner is denied', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const labelId = await t.mutation(api.mail.labels.create, {
			mailboxId: a.mailboxId,
			name: 'Important',
			color: '#ff8800',
		});
		expect(labelId).toBeDefined();

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.labels.create, {
				mailboxId: a.mailboxId,
				name: 'Foreign',
			})
		).rejects.toThrow();
	});

	it('toggleOnMessage rejects a label from a different mailbox', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const b = await seedMailbox(t, 'user-bob', 'bob@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		// A label that lives in Bob's mailbox.
		setUser('user-bob', 'editor');
		const bobLabel = await t.mutation(api.mail.labels.create, {
			mailboxId: b.mailboxId,
			name: 'BobLabel',
		});

		// Alice owns the message but the label is foreign to mailbox A.
		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.mail.labels.toggleOnMessage, {
				messageId,
				labelId: bobLabel as Id<'mailLabels'>,
				add: true,
			})
		).rejects.toThrow();
	});

	it('owner can apply a same-mailbox label to their own message', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const { messageId } = await seedMessage(t, a.mailboxId, a.inboxId, {
			unread: true,
		});

		setUser('user-alice', 'editor');
		const labelId = await t.mutation(api.mail.labels.create, {
			mailboxId: a.mailboxId,
			name: 'Receipts',
		});
		await t.mutation(api.mail.labels.toggleOnMessage, {
			messageId,
			labelId: labelId as Id<'mailLabels'>,
			add: true,
		});

		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.labelIds).toContain(labelId);
	});
});

// ════════════════════════════════════════════════════════════════════
// Filters — ownership + cross-mailbox folder/label action targets
// ════════════════════════════════════════════════════════════════════

describe('mail.filters ownership', () => {
	it('owner can create a filter; non-owner is denied', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId: a.mailboxId,
			name: 'From boss',
			conditions: [{ field: 'from', op: 'contains', value: 'boss@example.com' }],
			actions: [{ type: 'markFlagged' }],
		});
		expect(filterId).toBeDefined();

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.filters.create, {
				mailboxId: a.mailboxId,
				name: 'Sneaky',
				conditions: [{ field: 'from', op: 'contains', value: 'x@example.com' }],
				actions: [{ type: 'markRead' }],
			})
		).rejects.toThrow();
	});

	it('rejects a moveToFolder action targeting a different mailbox’s folder', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');
		const b = await seedMailbox(t, 'user-bob', 'bob@hinterland.camp');

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.mail.filters.create, {
				mailboxId: a.mailboxId,
				name: 'Misrouted',
				conditions: [{ field: 'from', op: 'contains', value: 'x@example.com' }],
				// Target folder lives in Bob's mailbox.
				actions: [{ type: 'moveToFolder', folderId: b.inboxId }],
			})
		).rejects.toThrow();
	});

	it('accepts a moveToFolder action targeting a same-mailbox folder', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId: a.mailboxId,
			name: 'To archive',
			conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }],
			actions: [{ type: 'moveToFolder', folderId: a.archiveId }],
		});
		expect(filterId).toBeDefined();
	});
});

// ════════════════════════════════════════════════════════════════════
// Mailbox display-name edit — ownership-scoped (mirrors labels.update)
// ════════════════════════════════════════════════════════════════════

describe('mail.mailbox.setDisplayName ownership', () => {
	it('owner can rename their own mailbox; non-owner is denied', async () => {
		const t = convexTest(schema, modules);
		const a = await seedMailbox(t, 'user-alice', 'alice@hinterland.camp');

		setUser('user-alice', 'editor');
		await t.mutation(api.mail.mailbox.setDisplayName, {
			mailboxId: a.mailboxId,
			displayName: 'Alice P.',
		});
		let mb = await t.run((ctx) => ctx.db.get(a.mailboxId));
		expect(mb?.displayName).toBe('Alice P.');

		// A blank value clears the display name back to undefined.
		await t.mutation(api.mail.mailbox.setDisplayName, {
			mailboxId: a.mailboxId,
			displayName: '   ',
		});
		mb = await t.run((ctx) => ctx.db.get(a.mailboxId));
		expect(mb?.displayName).toBeUndefined();

		// Bob (a different editor) cannot rename Alice's mailbox.
		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.mail.mailbox.setDisplayName, {
				mailboxId: a.mailboxId,
				displayName: 'Hijacked',
			})
		).rejects.toThrow();
	});
});
