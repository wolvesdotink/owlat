/**
 * mail.mailbox.queries.listThreads — the conversation (thread-grouped) inbox view.
 * Returns threads whose folderRoles include the folder, newest first, hiding
 * threads whose latest message is snoozed.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { listThreads } from '../mail/mailbox/queries';
import { applyThreadFolderMove } from '../mail/threadAggregates';
import type { ThreadListRow } from '../mail/mailbox/threadListRow';
import { enableFeatures } from './factories';
import { tableCountingDb, type QueriedDocuments } from './indexRecorder.testlib';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider')
	)
);

async function seedThread(t: ReturnType<typeof convexTest>, folderRoles: string[]) {
	let mailboxId!: Id<'mailboxes'>;
	let messageId!: Id<'mailMessages'>;
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hi',
			participants: ['a@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'hello',
			latestFromAddress: 'a@example.com',
			latestSubject: 'hi',
			folderRoles,
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const storageId = await ctx.storage.store(new Blob(['x']));
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m@example.com>',
			threadId,
			fromAddress: 'a@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'hi',
			normalizedSubject: 'hi',
			snippet: 'hello',
			rawStorageId: storageId,
			rawSize: 1,
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
		await ctx.db.patch(threadId, { latestMessageId: messageId });
	});
	return { mailboxId, messageId, threadId };
}

describe('mail.mailbox.queries.listThreads', () => {
	it('returns inbox threads, hiding non-inbox ones', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId } = await seedThread(t, ['inbox']);
		const res = await t.query(api.mail.mailbox.queries.listThreads, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(res.threads).toHaveLength(1);
		const sent = await t.query(api.mail.mailbox.queries.listThreads, {
			mailboxId,
			folderRole: 'sent',
		});
		expect(sent.threads).toHaveLength(0);
	});

	it('hides a thread whose latest message is snoozed', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, messageId } = await seedThread(t, ['inbox']);
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() + 60 * 60 * 1000 });
		});
		const res = await t.query(api.mail.mailbox.queries.listThreads, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(res.threads).toHaveLength(0);
	});

	it('names the latest sender by display name and drops a name the newest message lacks', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId } = await seedThread(t, ['inbox']);
		const deliver = async (
			from: string,
			messageId: string,
			receivedAt: number,
			inReplyTo?: string
		) => {
			const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
			await t.mutation(internal.mail.delivery.deliverToMailbox, {
				rawStorageId,
				rawSize: 3,
				recipientAddress: 'me@example.com',
				from,
				to: ['me@example.com'],
				cc: [],
				bcc: [],
				subject: 'Quarterly numbers',
				textBodyInline: 'see attached',
				snippet: 'see attached',
				messageId,
				inReplyTo,
				receivedAt,
				attachments: [],
			});
		};
		const rowFor = async () => {
			const res = await t.query(api.mail.mailbox.queries.listThreads, {
				mailboxId,
				folderRole: 'inbox',
			});
			return res.threads.find((row) => row.latestSubject === 'Quarterly numbers');
		};

		const now = Date.now();
		await deliver('Ben Ortiz <ben@acme.example>', '<q-1@acme.example>', now + 1000);
		expect(await rowFor()).toMatchObject({
			latestFromAddress: 'ben@acme.example',
			latestFromName: 'Ben Ortiz',
		});

		await deliver('carol@acme.example', '<q-2@acme.example>', now + 2000, '<q-1@acme.example>');
		const row = await rowFor();
		expect(row?.latestFromAddress).toBe('carol@acme.example');
		expect(row).not.toHaveProperty('latestFromName');
	});
});

const INBOX_THREADS = 10;
const ARCHIVED_THREADS = 1_000;
/** The web client's ceiling (`useGrowableLimit`). */
const MAX_LIMIT = 500;

/** A mailbox whose 10 Inbox threads are older than its 1,000 archived ones. */
async function seedMostlyArchived(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const thread = (subject: string, folderRoles: string[], lastMessageAt: number) =>
			ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: subject,
				participants: ['a@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt,
				firstMessageAt: lastMessageAt,
				latestSnippet: '',
				latestFromAddress: 'a@example.com',
				latestSubject: subject,
				latestSnoozedUntil: null,
				folderRoles,
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
		for (let i = 0; i < INBOX_THREADS; i++) {
			await thread(`inbox-${i}`, ['inbox'], now - 10_000_000 + i);
		}
		for (let i = 0; i < ARCHIVED_THREADS; i++) {
			await thread(`archived-${i}`, ['archive'], now - 1_000_000 + i);
		}
		return mailboxId;
	});
}

type ListThreadsHandler = (
	ctx: QueryCtx,
	args: { mailboxId: Id<'mailboxes'>; folderRole: string; limit?: number }
) => Promise<{ threads: ThreadListRow[]; hasMore: boolean }>;

/**
 * Page the Inbox the way the conversation list does: start at `page`, and
 * while the read reports more, grow the limit by `page` up to the client's
 * ceiling. Counts the thread documents each request's queries hand back.
 */
async function pageLikeTheClient(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	page: number
) {
	const handler = (listThreads as unknown as { _handler: ListThreadsHandler })._handler;
	const requests: Array<{ limit: number; threadsRead: number; rows: number }> = [];
	let limit = page;
	for (;;) {
		const counts: QueriedDocuments = {};
		const result = await t.run((ctx) =>
			handler({ ...ctx, db: tableCountingDb(ctx.db, counts) } as unknown as QueryCtx, {
				mailboxId,
				folderRole: 'inbox',
				limit,
			})
		);
		requests.push({ limit, threadsRead: counts['mailThreads'] ?? 0, rows: result.threads.length });
		if (!result.hasMore || limit >= MAX_LIMIT) {
			return { requests, subjects: result.threads.map((row) => row.latestSubject) };
		}
		limit = Math.min(limit + page, MAX_LIMIT);
	}
}

const ALL_INBOX = Array.from({ length: INBOX_THREADS }, (_, i) => `inbox-${INBOX_THREADS - 1 - i}`);

describe('listThreads in a mostly archived mailbox', () => {
	it('reads only Inbox threads and reaches every one of them', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['mail.external']);
			const mailboxId = await seedMostlyArchived(t);
			await t.mutation(internal.migrations['0072_backfill_thread_inbox_recency'].run, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			const firstPage = await pageLikeTheClient(t, mailboxId, 50);
			expect(firstPage).toEqual({
				requests: [{ limit: 50, threadsRead: 10, rows: 10 }],
				subjects: ALL_INBOX,
			});

			// Each load more reads the rows it shows plus the one that says more exist.
			const smallPages = await pageLikeTheClient(t, mailboxId, 4);
			expect(smallPages).toEqual({
				requests: [
					{ limit: 4, threadsRead: 5, rows: 4 },
					{ limit: 8, threadsRead: 9, rows: 8 },
					{ limit: 12, threadsRead: 10, rows: 10 },
				],
				subjects: ALL_INBOX,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('scans by recency until the backfill completes, and still reaches every Inbox thread', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const mailboxId = await seedMostlyArchived(t);

		const walk = await pageLikeTheClient(t, mailboxId, 50);
		// A read that stops at its scan cap says more may exist, so the client
		// grows the limit until the scan passes the archived threads.
		expect(walk.requests.map((r) => r.threadsRead)).toEqual([153, 303, 453, 603, 753, 903, 1010]);
		expect(walk.requests.map((r) => r.rows)).toEqual([0, 0, 0, 0, 0, 0, 10]);
		expect(walk.subjects).toEqual(ALL_INBOX);
	});
});

describe('mailThreads.inboxLastMessageAt', () => {
	it('follows a delivery into the Inbox and a move out of it', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId } = await seedThread(t, ['inbox']);
		const receivedAt = Date.now() + 1000;
		const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
		await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 3,
			recipientAddress: 'me@example.com',
			from: 'ben@acme.example',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Offsite',
			textBodyInline: 'dates',
			snippet: 'dates',
			messageId: '<offsite@acme.example>',
			receivedAt,
			attachments: [],
		});
		const delivered = await t.run(async (ctx) => {
			const threads = await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			return threads.find((thread) => thread.latestSubject === 'Offsite')!;
		});
		expect(delivered.inboxLastMessageAt).toBe(receivedAt);

		const moved = await t.run(async (ctx) => {
			const now = Date.now();
			const archiveId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'Archive',
				role: 'archive',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', delivered._id))
				.collect();
			for (const message of messages) await ctx.db.patch(message._id, { folderId: archiveId });
			await applyThreadFolderMove(ctx, delivered._id, {
				sourceFolderIds: messages.map((message) => message.folderId),
				target: (await ctx.db.get(archiveId))!,
			});
			return await ctx.db.get(delivered._id);
		});
		expect(moved).toMatchObject({ folderRoles: ['archive'], inboxLastMessageAt: null });
	});
});
