/**
 * Plan idea 1 + 12 — the two PUBLIC reads over `mailMessages.outbound`.
 *
 * `outbound` has been written since ADR-0012 and read by nothing outside the
 * backend, which is why a hard bounce looked exactly like a delivered mail.
 * These tests lock the two things that makes the difference:
 *
 *  - `mailbox.messages.listThreadOutboundDelivery` returns one row per SENT
 *    message in the thread with every per-recipient state, and NOTHING for an
 *    inbound-only thread (no false "queued") — and refuses a caller with no
 *    access to the mailbox.
 *  - `mailbox.queries.sendingHealth` counts recipients, not messages, over a
 *    bounded window of the sent folder, and names the newest failure.
 *
 * Both are soft-auth reads, so the refusal assertion is `null`, not a throw.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});

function setSession(userId: string, role: 'owner' | 'member' = 'owner') {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role,
		activeOrganizationId: 'org-1',
	});
}

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockReset();
});

type OutboundRecipient = {
	idx: number;
	address: string;
	mtaJobId: string;
	state: 'queued' | 'sent' | 'bounced' | 'failed';
	sentAt?: number;
	acceptedAt?: number;
	bouncedAt?: number;
	failedAt?: number;
	bounceMessage?: string;
	errorCode?: string;
};

type Outbound = {
	state: 'queued' | 'sent' | 'bounced' | 'failed' | 'partial';
	recipients: OutboundRecipient[];
};

const NOW = 1_770_000_000_000;

async function insertFolder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
	name: string,
	role: 'inbox' | 'sent'
): Promise<Id<'mailFolders'>> {
	return ctx.db.insert('mailFolders', {
		mailboxId,
		name,
		role,
		uidValidity: NOW,
		uidNext: 1,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: 0,
		subscribed: true,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

/** One `mailMessages` row; `outbound` present marks it as a message WE sent. */
async function insertMessage(
	ctx: { db: DatabaseWriter; storage: { store: (b: Blob) => Promise<Id<'_storage'>> } },
	seed: {
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		threadId: Id<'mailThreads'>;
		uid: number;
		receivedAt: number;
		outbound?: Outbound;
	}
): Promise<Id<'mailMessages'>> {
	const rawStorageId = await ctx.storage.store(new Blob(['raw']));
	return ctx.db.insert('mailMessages', {
		mailboxId: seed.mailboxId,
		folderId: seed.folderId,
		uid: seed.uid,
		modseq: seed.uid,
		rfc822MessageId: `<m${seed.uid}@example.com>`,
		threadId: seed.threadId,
		fromAddress: 'me@example.com',
		toAddresses: ['ines@northwind.studio'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Contract',
		normalizedSubject: 'contract',
		snippet: 'Contract attached',
		rawStorageId,
		rawSize: 3,
		attachments: [],
		hasAttachments: false,
		flagSeen: true,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		labelIds: [],
		receivedAt: seed.receivedAt,
		internalDate: seed.receivedAt,
		...(seed.outbound ? { outbound: seed.outbound } : {}),
		createdAt: seed.receivedAt,
		updatedAt: seed.receivedAt,
	});
}

async function insertThread(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>
): Promise<Id<'mailThreads'>> {
	return ctx.db.insert('mailThreads', {
		mailboxId,
		normalizedSubject: 'contract',
		participants: ['ines@northwind.studio'],
		messageCount: 1,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: NOW,
		firstMessageAt: NOW,
		latestSnippet: 'Contract attached',
		latestFromAddress: 'me@example.com',
		latestSubject: 'Contract',
		folderRoles: ['sent'],
		labelIds: [],
		createdAt: NOW,
		updatedAt: NOW,
	});
}

const mixedOutbound: Outbound = {
	state: 'partial',
	recipients: [
		{
			idx: 0,
			address: 'ines@northwind.studio',
			mtaJobId: 'pb-x-0',
			state: 'sent',
			sentAt: NOW + 1000,
			acceptedAt: NOW + 2000,
		},
		{
			idx: 1,
			address: 'jonas@acme.example',
			mtaJobId: 'pb-x-1',
			state: 'bounced',
			sentAt: NOW + 1000,
			bouncedAt: NOW + 90_000,
			bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
		},
	],
};

describe('listThreadOutboundDelivery', () => {
	it('returns per-recipient states for the sent message and hides the mta job id', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		let messageId!: Id<'mailMessages'>;
		await t.run(async (ctx) => {
			const sent = await insertFolder(ctx, mailboxId, 'Sent', 'sent');
			const threadId = await insertThread(ctx, mailboxId);
			messageId = await insertMessage(ctx, {
				mailboxId,
				folderId: sent,
				threadId,
				uid: 1,
				receivedAt: NOW,
				outbound: mixedOutbound,
			});
		});

		const rows = await t.query(api.mail.mailbox.messages.listThreadOutboundDelivery, {
			messageId,
		});
		expect(rows).toHaveLength(1);
		expect(rows?.[0]?.messageId).toBe(messageId);
		expect(rows?.[0]?.state).toBe('partial');
		expect(rows?.[0]?.recipients).toEqual([
			{
				idx: 0,
				address: 'ines@northwind.studio',
				state: 'sent',
				sentAt: NOW + 1000,
				acceptedAt: NOW + 2000,
			},
			{
				idx: 1,
				address: 'jonas@acme.example',
				state: 'bounced',
				sentAt: NOW + 1000,
				bouncedAt: NOW + 90_000,
				bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
			},
		]);
	});

	it('returns an empty list for a thread with no sent message (never a false queued)', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		let messageId!: Id<'mailMessages'>;
		await t.run(async (ctx) => {
			const inbox = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			const threadId = await insertThread(ctx, mailboxId);
			messageId = await insertMessage(ctx, {
				mailboxId,
				folderId: inbox,
				threadId,
				uid: 1,
				receivedAt: NOW,
			});
		});

		await expect(
			t.query(api.mail.mailbox.messages.listThreadOutboundDelivery, { messageId })
		).resolves.toEqual([]);
	});

	it('refuses a caller with no access to the mailbox', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		let messageId!: Id<'mailMessages'>;
		await t.run(async (ctx) => {
			const sent = await insertFolder(ctx, mailboxId, 'Sent', 'sent');
			const threadId = await insertThread(ctx, mailboxId);
			messageId = await insertMessage(ctx, {
				mailboxId,
				folderId: sent,
				threadId,
				uid: 1,
				receivedAt: NOW,
				outbound: mixedOutbound,
			});
		});

		// A plain member of another org's session: not the mailbox owner, no
		// membership row, no owner/admin bypass.
		setSession('user-B', 'member');
		await expect(
			t.query(api.mail.mailbox.messages.listThreadOutboundDelivery, { messageId })
		).resolves.toBeNull();

		// Anonymous.
		sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(null);
		await expect(
			t.query(api.mail.mailbox.messages.listThreadOutboundDelivery, { messageId })
		).resolves.toBeNull();
	});
});

describe('sendingHealth', () => {
	it('counts recipients (not messages) and names the newest failure', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		await t.run(async (ctx) => {
			const sent = await insertFolder(ctx, mailboxId, 'Sent', 'sent');
			const threadId = await insertThread(ctx, mailboxId);
			await insertMessage(ctx, {
				mailboxId,
				folderId: sent,
				threadId,
				uid: 1,
				receivedAt: NOW,
				outbound: mixedOutbound,
			});
			await insertMessage(ctx, {
				mailboxId,
				folderId: sent,
				threadId,
				uid: 2,
				receivedAt: NOW + 200_000,
				outbound: {
					state: 'failed',
					recipients: [
						{
							idx: 0,
							address: 'nobody@acme.example',
							mtaJobId: 'pb-y-0',
							state: 'failed',
							failedAt: NOW + 300_000,
							bounceMessage: '550 5.1.1 The email account that you tried to reach does not exist',
							errorCode: '5.1.1',
						},
					],
				},
			});
			// A sent-folder row with no `outbound` (IMAP-synced / pre-lifecycle):
			// evidence-free, so it counts on NEITHER side of the ratio.
			await insertMessage(ctx, {
				mailboxId,
				folderId: sent,
				threadId,
				uid: 3,
				receivedAt: NOW + 400_000,
			});
		});

		const health = await t.query(api.mail.mailbox.queries.sendingHealth, { mailboxId });
		expect(health).toEqual({
			sends: 2,
			attempts: 3,
			accepted: 1,
			bounced: 1,
			failed: 1,
			pending: 0,
			latestFailure: {
				address: 'nobody@acme.example',
				state: 'failed',
				at: NOW + 300_000,
				bounceMessage: '550 5.1.1 The email account that you tried to reach does not exist',
				errorCode: '5.1.1',
			},
		});
	});

	it('reports a zero window for a mailbox that has never sent', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		await t.run(async (ctx) => {
			await insertFolder(ctx, mailboxId, 'Sent', 'sent');
		});

		const health = await t.query(api.mail.mailbox.queries.sendingHealth, { mailboxId });
		expect(health).toEqual({
			sends: 0,
			attempts: 0,
			accepted: 0,
			bounced: 0,
			failed: 0,
			pending: 0,
			latestFailure: null,
		});
	});

	it('refuses a caller with no access to the mailbox', async () => {
		setSession('user-A');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A', organizationId: 'org-1' });
		await t.run(async (ctx) => {
			await insertFolder(ctx, mailboxId, 'Sent', 'sent');
		});

		setSession('user-B', 'member');
		await expect(
			t.query(api.mail.mailbox.queries.sendingHealth, { mailboxId })
		).resolves.toBeNull();
	});
});
