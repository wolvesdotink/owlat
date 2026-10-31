/**
 * Pinned conversations (mail/pins.ts):
 *   - a pin lands on the thread, shows in `listPinned` and on the list rows,
 *     and survives a fresh read, a new delivery, an archive and an aggregate
 *     rebuild
 *   - pinning twice is harmless, and the star stays independent both ways
 *   - the band refuses a sixth conversation without evicting one, and an
 *     unpin frees the slot
 *   - many messages of one thread count once; a cross-mailbox drop is refused
 *   - a caller without mailbox access, or an instance without the Postbox,
 *     gets nothing
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { rebuildThreadAggregates } from '../mail/threadAggregates';

const sessionMock = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockImplementation(session),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(session),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
}

async function setup(opts: { feature?: boolean } = {}): Promise<{ t: T; seeded: Seeded }> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	if (opts.feature !== false) await enableFeatures(t, ['mail.external']);
	const seeded = await seedMailbox(t, 'me@example.com');
	return { t, seeded };
}

async function seedMailbox(t: T, address: string): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address,
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = (name: string, role: 'inbox' | 'archive') =>
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
		return {
			mailboxId,
			inboxId: await folder('INBOX', 'inbox'),
			archiveId: await folder('Archive', 'archive'),
		};
	});
}

/** One inbound thread with `count` inbox messages, newest last. */
async function seedThread(
	t: T,
	seeded: Seeded,
	subject: string,
	count = 1
): Promise<{ threadId: Id<'mailThreads'>; messageIds: Id<'mailMessages'>[] }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: subject.toLowerCase(),
			participants: ['alice@example.com', 'me@example.com'],
			messageCount: count,
			unreadCount: count,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: subject,
			latestFromAddress: 'alice@example.com',
			latestSubject: subject,
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const messageIds: Id<'mailMessages'>[] = [];
		for (let i = 0; i < count; i++) {
			const rawStorageId = await ctx.storage.store(new Blob([subject]));
			messageIds.push(
				await ctx.db.insert('mailMessages', {
					mailboxId: seeded.mailboxId,
					folderId: seeded.inboxId,
					uid: i + 1,
					modseq: 1,
					rfc822MessageId: `${subject.replace(/\W+/g, '-')}-${i}@example.com`,
					threadId,
					fromAddress: 'alice@example.com',
					fromName: 'Alice',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject,
					normalizedSubject: subject.toLowerCase(),
					snippet: subject,
					rawStorageId,
					rawSize: subject.length,
					attachments: [],
					hasAttachments: false,
					flagSeen: false,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + i,
					internalDate: now + i,
					createdAt: now,
					updatedAt: now,
				})
			);
		}
		await ctx.db.patch(threadId, { latestMessageId: messageIds[messageIds.length - 1] });
		return { threadId, messageIds };
	});
}

const pin = (t: T, messageIds: Id<'mailMessages'>[], pinned = true) =>
	t.mutation(api.mail.pins.setPinned, { messageIds, pinned });

const band = async (t: T, mailboxId: Id<'mailboxes'>) =>
	(await t.query(api.mail.pins.listPinned, { mailboxId })).conversations.map((c) => c.subject);

/** The thread's pin time; null when unpinned (t.run cannot return undefined). */
const pinnedAtOf = (t: T, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) => (await ctx.db.get(threadId))?.pinnedAt ?? null);

describe('pinned conversations', () => {
	it('pins a conversation into the band and onto its list rows', async () => {
		const { t, seeded } = await setup();
		const { threadId, messageIds } = await seedThread(t, seeded, 'quarterly plan', 2);

		const result = await pin(t, [messageIds[0]!]);
		expect(result).toEqual({ ok: true, threadIds: [threadId], pinnedCount: 1 });

		const listed = await t.query(api.mail.pins.listPinned, { mailboxId: seeded.mailboxId });
		expect(listed.limit).toBe(5);
		expect(listed.conversations).toEqual([
			expect.objectContaining({
				threadId,
				// The band opens the newest message, not the one that was pinned.
				messageId: messageIds[1],
				subject: 'quarterly plan',
				fromName: 'Alice',
				messageCount: 2,
			}),
		]);
		const pinnedAt = await pinnedAtOf(t, threadId);
		expect(pinnedAt).toBeGreaterThan(0);

		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages.map((m) => m.pinnedAt)).toEqual([pinnedAt, pinnedAt]);
		const threads = await t.query(api.mail.mailbox.queries.listThreads, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(threads.threads[0]?.pinnedAt).toBe(pinnedAt);
	});

	it('is idempotent and leaves the star alone, both ways', async () => {
		const { t, seeded } = await setup();
		const { threadId, messageIds } = await seedThread(t, seeded, 'starred and pinned');
		const messageId = messageIds[0]!;

		await pin(t, [messageId]);
		const first = await pinnedAtOf(t, threadId);
		expect(await pin(t, [messageId])).toMatchObject({ pinnedCount: 1 });
		expect(await pinnedAtOf(t, threadId)).toBe(first);

		await t.mutation(api.mail.messageActions.setStar, { messageId, starred: true });
		expect(await pinnedAtOf(t, threadId)).toBe(first);
		await pin(t, [messageId], false);
		const after = await t.run(async (ctx) => ({
			thread: await ctx.db.get(threadId),
			message: await ctx.db.get(messageId),
		}));
		expect(after.thread?.pinnedAt).toBeUndefined();
		expect(after.thread?.hasFlagged).toBe(true);
		expect(after.message?.flagFlagged).toBe(true);
		// Unpinning what is not pinned is a no-op too.
		expect(await pin(t, [messageId], false)).toMatchObject({ pinnedCount: 0 });
		expect(await band(t, seeded.mailboxId)).toEqual([]);
	});

	it('keeps the pin through a new delivery, an archive and an aggregate rebuild', async () => {
		const { t, seeded } = await setup();
		const { threadId, messageIds } = await seedThread(t, seeded, 'long running');
		await pin(t, messageIds);
		const pinnedAt = await pinnedAtOf(t, threadId);

		const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
		await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 3,
			recipientAddress: 'me@example.com',
			from: 'alice@example.com',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Re: long running',
			textBodyInline: 'one more thing',
			snippet: 'one more thing',
			messageId: '<long-running-reply@example.com>',
			inReplyTo: '<long-running-0@example.com>',
			receivedAt: Date.now() + 10_000,
			attachments: [],
		});
		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.messageCount).toBe(2);
		expect(thread?.pinnedAt).toBe(pinnedAt);

		await t.mutation(api.mail.messageActions.archive, { messageIds });
		await t.run((ctx) => rebuildThreadAggregates(ctx, threadId));
		expect(await pinnedAtOf(t, threadId)).toBe(pinnedAt);
		// The band does not depend on where the mail sits or on the list's pages.
		const listed = await t.query(api.mail.pins.listPinned, { mailboxId: seeded.mailboxId });
		expect(listed.conversations.map((c) => c.threadId)).toEqual([threadId]);
		expect(listed.conversations[0]?.subject).toBe('Re: long running');
	});

	it('refuses a sixth pin without evicting one, and an unpin frees the slot', async () => {
		const { t, seeded } = await setup();
		const threads = [];
		for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) {
			threads.push(await seedThread(t, seeded, name));
		}
		for (const thread of threads.slice(0, 5)) await pin(t, thread.messageIds);
		expect(await band(t, seeded.mailboxId)).toEqual(['one', 'two', 'three', 'four', 'five']);

		await expect(pin(t, threads[5]!.messageIds)).rejects.toThrow(/up to 5 conversations/);
		expect(await band(t, seeded.mailboxId)).toEqual(['one', 'two', 'three', 'four', 'five']);
		expect(await pinnedAtOf(t, threads[5]!.threadId)).toBeNull();
		// Re-pinning something already pinned is not a sixth conversation.
		expect(await pin(t, threads[0]!.messageIds)).toMatchObject({ pinnedCount: 5 });

		await pin(t, threads[1]!.messageIds, false);
		expect(await pin(t, threads[5]!.messageIds)).toMatchObject({ pinnedCount: 5 });
		expect(await band(t, seeded.mailboxId)).toEqual(['one', 'three', 'four', 'five', 'six']);
	});

	it('refuses a multi-thread drop that would overflow, writing nothing', async () => {
		const { t, seeded } = await setup();
		const threads = [];
		for (const name of ['a', 'b', 'c', 'd', 'e', 'f'])
			threads.push(await seedThread(t, seeded, name));
		await pin(
			t,
			threads.slice(0, 3).flatMap((thread) => thread.messageIds)
		);
		await expect(
			pin(
				t,
				threads.slice(3).flatMap((thread) => thread.messageIds)
			)
		).rejects.toThrow();
		expect(await band(t, seeded.mailboxId)).toEqual(['a', 'b', 'c']);
	});

	it('counts the messages of one thread once', async () => {
		const { t, seeded } = await setup();
		const { threadId, messageIds } = await seedThread(t, seeded, 'busy thread', 3);
		expect(await pin(t, [...messageIds, messageIds[0]!])).toEqual({
			ok: true,
			threadIds: [threadId],
			pinnedCount: 1,
		});
	});

	it('refuses a drop that mixes mailboxes', async () => {
		const { t, seeded } = await setup();
		const other = await seedMailbox(t, 'other@example.com');
		const mine = await seedThread(t, seeded, 'mine');
		const theirs = await seedThread(t, other, 'theirs');
		await expect(pin(t, [mine.messageIds[0]!, theirs.messageIds[0]!])).rejects.toThrow(
			/different mailboxes/
		);
		expect(await pinnedAtOf(t, mine.threadId)).toBeNull();
		await expect(pin(t, [])).rejects.toThrow();
	});

	it('gives a caller without mailbox access nothing', async () => {
		const { t, seeded } = await setup();
		const { threadId, messageIds } = await seedThread(t, seeded, 'private');
		await pin(t, messageIds);
		sessionMock.userId = 'someone-else';
		sessionMock.role = 'editor';
		try {
			await expect(pin(t, messageIds, false)).rejects.toThrow();
			expect(await band(t, seeded.mailboxId)).toEqual([]);
		} finally {
			sessionMock.userId = 'test-user';
			sessionMock.role = 'owner';
		}
		expect(await pinnedAtOf(t, threadId)).toBeGreaterThan(0);
	});

	it('does not exist on an instance without the Postbox', async () => {
		const { t, seeded } = await setup({ feature: false });
		const { threadId, messageIds } = await seedThread(t, seeded, 'no postbox');
		await expect(pin(t, messageIds)).rejects.toThrow();
		await expect(
			t.query(api.mail.pins.listPinned, { mailboxId: seeded.mailboxId })
		).rejects.toThrow();
		expect(await pinnedAtOf(t, threadId)).toBeNull();
	});
});
