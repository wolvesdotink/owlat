/**
 * archiveThreads: archive whole conversations from the all-inboxes list.
 *
 * What it must get right: every Inbox copy of each thread moves (not just the
 * newest message), nothing outside the Inbox moves, each mailbox's mail lands
 * in that mailbox's own Archive, a mailbox the caller cannot reach is left
 * alone, and the returned provenance is enough for the usual move-back Undo.
 * A conversation larger than one call's budgets resumes where the call
 * stopped, without skipping or repeating mail, and every call stays inside
 * Convex's transaction limits.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, type SeededFolderRole } from './helpers.testlib';
import { withCreationTime } from '../../__tests__/helpers/creationTimeSeam';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type T = TestConvex<typeof schema>;
type Folders = Record<'inbox' | 'archive' | 'sent', Id<'mailFolders'>>;

async function seedBox(
	t: T,
	userId = 'user-A',
	address = 'me@owlat.test',
	organizationId = 'org-1'
) {
	const mailboxId = await seedMailbox(t, { userId, address, organizationId });
	const folders = {
		inbox: await seedFolder(t, mailboxId, 'inbox'),
		archive: await seedFolder(t, mailboxId, 'archive'),
		sent: await seedFolder(t, mailboxId, 'sent'),
	} satisfies Folders;
	return { mailboxId, folders };
}

type Spec = { role?: SeededFolderRole; snoozedUntil?: number; receivedAt?: number };

/**
 * One thread with a message per spec, 1 s apart unless a spec pins its
 * `receivedAt`, folder counters kept consistent.
 */
async function seedThread(t: T, mailboxId: Id<'mailboxes'>, folders: Folders, specs: Spec[]) {
	return await t.run(async (ctx) => {
		const base = Date.now() - specs.length * 1000;
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'news',
			participants: ['news@example.com'],
			messageCount: specs.length,
			unreadCount: specs.length,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: base + specs.length * 1000,
			firstMessageAt: base,
			latestSnippet: 'news',
			latestFromAddress: 'news@example.com',
			latestSubject: 'news',
			folderRoles: [...new Set(specs.map((s) => s.role ?? 'inbox'))],
			labelIds: [],
			createdAt: base,
			updatedAt: base,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageIds: Id<'mailMessages'>[] = [];
		for (const [i, spec] of specs.entries()) {
			const folderId = folders[(spec.role ?? 'inbox') as keyof Folders];
			const folder = (await ctx.db.get(folderId))!;
			const receivedAt = spec.receivedAt ?? base + i * 1000;
			messageIds.push(
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId,
					uid: folder.uidNext,
					modseq: folder.highestModseq + 1,
					rfc822MessageId: `<news-${threadId}-${i}@example.com>`,
					threadId,
					fromAddress: 'news@example.com',
					toAddresses: ['me@owlat.test'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `news ${i}`,
					normalizedSubject: 'news',
					snippet: `news ${i}`,
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
					...(spec.snoozedUntil ? { snoozedUntil: spec.snoozedUntil } : {}),
					receivedAt,
					internalDate: receivedAt,
					createdAt: receivedAt,
					updatedAt: receivedAt,
				})
			);
			await ctx.db.patch(folderId, {
				uidNext: folder.uidNext + 1,
				highestModseq: folder.highestModseq + 1,
				totalCount: folder.totalCount + 1,
				unseenCount: folder.unseenCount + (spec.snoozedUntil ? 0 : 1),
			});
		}
		return { threadId, messageIds };
	});
}

async function folderOf(t: T, id: Id<'mailMessages'>) {
	return await t.run(async (ctx) => (await ctx.db.get(id))!.folderId);
}

/** Archive these threads from the top, in one call. */
async function archiveThreads(threadIds: Id<'mailThreads'>[]) {
	return await t.mutation(api.mail.threadArchive.archiveThreads, {
		threads: threadIds.map((threadId) => ({ threadId })),
	});
}

/**
 * Call again for every unfinished thread, from where it stopped, until all are
 * done (what `useInboxesThreadArchive` does); every call's result, in order.
 */
async function archiveUntilDone(threadIds: Id<'mailThreads'>[]) {
	let threads: {
		threadId: Id<'mailThreads'>;
		from?: { receivedAt: number; creationTime: number };
	}[] = threadIds.map((threadId) => ({ threadId }));
	const calls = [];
	while (threads.length > 0) {
		if (calls.length === 50) throw new Error('archiveThreads did not finish in 50 calls');
		const result = await t.mutation(api.mail.threadArchive.archiveThreads, { threads });
		calls.push(result);
		threads = result.threads
			.filter((outcome) => !outcome.isDone)
			.map(({ threadId, from }) => (from ? { threadId, from } : { threadId }));
	}
	return calls;
}

let t: T;
beforeEach(() => {
	t = convexTest({ schema, modules });
});

describe('archiveThreads', () => {
	it("moves every Inbox copy of the thread, and only those, to the mailbox's Archive", async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{},
			{ role: 'sent' },
			{},
		]);

		const result = await archiveThreads([threadId]);

		expect(result.moved.map((m) => m.messageId).sort()).toEqual(
			[messageIds[0]!, messageIds[2]!].sort()
		);
		expect(result.moved.every((m) => m.sourceFolderId === folders.inbox)).toBe(true);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.archive);
		expect(await folderOf(t, messageIds[1]!)).toBe(folders.sent);
		expect(await folderOf(t, messageIds[2]!)).toBe(folders.archive);
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread!.folderRoles).not.toContain('inbox');
		expect(result.threads).toEqual([
			expect.objectContaining({ threadId, moved: 2, isDone: true, hasLeftInbox: true }),
		]);
	});

	it("files each mailbox's threads in that mailbox's own Archive, in one call", async () => {
		const a = await seedBox(t, 'user-A', 'me@owlat.test');
		const b = await seedBox(t, 'user-A', 'other@owlat.test');
		const inA = await seedThread(t, a.mailboxId, a.folders, [{}]);
		const inB = await seedThread(t, b.mailboxId, b.folders, [{}, {}]);

		const result = await archiveThreads([inA.threadId, inB.threadId]);

		expect(result.moved).toHaveLength(3);
		expect(await folderOf(t, inA.messageIds[0]!)).toBe(a.folders.archive);
		for (const id of inB.messageIds) expect(await folderOf(t, id)).toBe(b.folders.archive);
	});

	it('leaves a snoozed Inbox message where it is', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{ snoozedUntil: Date.now() + 86_400_000 },
			{},
		]);

		const result = await archiveThreads([threadId]);

		expect(result.moved.map((m) => m.messageId)).toEqual([messageIds[1]]);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.inbox);
	});

	it('skips a thread in a mailbox the caller cannot reach', async () => {
		const mine = await seedBox(t);
		// Another organization's mailbox: no role reaches it.
		const theirs = await seedBox(t, 'user-B', 'b@owlat.test', 'org-2');
		const own = await seedThread(t, mine.mailboxId, mine.folders, [{}]);
		const foreign = await seedThread(t, theirs.mailboxId, theirs.folders, [{}]);

		const result = await archiveThreads([foreign.threadId, own.threadId]);

		expect(result.moved.map((m) => m.messageId)).toEqual(own.messageIds);
		expect(await folderOf(t, foreign.messageIds[0]!)).toBe(theirs.folders.inbox);
	});

	it('returns provenance the move-back Undo can restore from', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [{}, {}]);
		const { moved } = await archiveThreads([threadId]);

		await t.mutation(api.mail.messageActions.move, {
			messageIds: moved.map((m) => m.messageId),
			targetFolderId: moved[0]!.sourceFolderId,
		});

		for (const id of messageIds) expect(await folderOf(t, id)).toBe(folders.inbox);
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread!.folderRoles).toContain('inbox');
	});

	it('refuses more conversations than one call may archive, before moving anything', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [{}]);

		await expect(
			t.mutation(api.mail.threadArchive.archiveThreads, {
				threads: Array.from({ length: 101 }, () => ({ threadId })),
			})
		).rejects.toThrow(/At most 100/);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.inbox);
	});

	it('does nothing for an empty list or a thread with no Inbox mail', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId } = await seedThread(t, mailboxId, folders, [{ role: 'sent' }]);

		expect((await archiveThreads([])).moved).toEqual([]);
		expect((await archiveThreads([threadId])).moved).toEqual([]);
	});

	it('archives a conversation with more Inbox mail than one call moves, whole, over resumed calls', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: 150 }, () => ({}))
		);
		const hundredth = await t.run(async (ctx) => (await ctx.db.get(messageIds[100]!))!);

		const calls = await archiveUntilDone([threadId]);

		expect(calls.map((call) => call.threads[0])).toEqual([
			{
				threadId,
				moved: 100,
				isDone: false,
				// The first message the call left.
				from: { receivedAt: hundredth.receivedAt, creationTime: hundredth._creationTime },
				hasLeftInbox: false,
			},
			expect.objectContaining({ moved: 50, isDone: true, hasLeftInbox: true }),
		]);
		expect(calls.flatMap((call) => call.moved.map((m) => m.messageId)).sort()).toEqual(
			[...messageIds].sort()
		);
		for (const id of messageIds) expect(await folderOf(t, id)).toBe(folders.archive);
	});

	it('walks past a long snoozed run to the mail after it', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const later = Date.now() + 86_400_000;
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			...Array.from({ length: 120 }, () => ({ snoozedUntil: later })),
			{},
		]);

		const result = await archiveThreads([threadId]);

		expect(result.moved.map((m) => m.messageId)).toEqual([messageIds[120]]);
		// The snoozed mail keeps the conversation in the Inbox list.
		expect(result.threads[0]).toMatchObject({ moved: 1, isDone: true, hasLeftInbox: false });
	});

	it('reports a conversation it could not archive as still in the Inbox', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId } = await seedThread(t, mailboxId, folders, [
			{ snoozedUntil: Date.now() + 86_400_000 },
			{ role: 'sent' },
		]);
		const listed = async () =>
			(
				await t.query(api.mail.mailbox.queries.listThreads, { mailboxId, folderRole: 'inbox' })
			).threads.map((row) => row._id);
		expect(await listed()).toContain(threadId);

		const result = await archiveThreads([threadId]);

		expect(result.moved).toEqual([]);
		expect(result.threads[0]).toMatchObject({ moved: 0, isDone: true, hasLeftInbox: false });
		expect(await listed()).toContain(threadId);
	});

	it('resumes at the given position, including later ones received at the same time', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const at = Date.now() - 60_000;
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{ receivedAt: at },
			{ receivedAt: at },
			{ receivedAt: at + 1000 },
		]);
		const second = await t.run(async (ctx) => (await ctx.db.get(messageIds[1]!))!);

		const result = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threads: [{ threadId, from: { receivedAt: at, creationTime: second._creationTime } }],
		});

		expect(result.moved.map((m) => m.messageId).sort()).toEqual(
			[messageIds[1]!, messageIds[2]!].sort()
		);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.inbox);
	});

	it('hands back what one call could not reach, and a second call finishes it', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const later = Date.now() + 86_400_000;
		// More snoozed mail than one call reads, then one message to archive.
		const big = await seedThread(t, mailboxId, folders, [
			...Array.from({ length: 2000 }, () => ({ snoozedUntil: later })),
			{},
		]);
		const small = await seedThread(t, mailboxId, folders, [{}]);

		const first = await archiveThreads([big.threadId, small.threadId]);

		expect(first.moved).toEqual([]);
		expect(first.threads).toEqual([
			expect.objectContaining({ threadId: big.threadId, isDone: false, moved: 0 }),
			{ threadId: small.threadId, moved: 0, isDone: false, from: null, hasLeftInbox: false },
		]);
		expect(first.threads[0]!.from).not.toBeNull();

		const second = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threads: first.threads.map(({ threadId, from }) =>
				from ? { threadId, from } : { threadId }
			),
		});

		expect(second.moved.map((m) => m.messageId).sort()).toEqual(
			[big.messageIds[2000]!, small.messageIds[0]!].sort()
		);
		expect(second.threads).toEqual([
			expect.objectContaining({ threadId: big.threadId, moved: 1, isDone: true }),
			expect.objectContaining({ threadId: small.threadId, moved: 1, hasLeftInbox: true }),
		]);
	});
	it('archives every message of a tie on both timestamps that spans calls', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const at = Date.now() - 60_000;
		// One import batch: one receivedAt, one creation time, more than one call moves.
		const { threadId, messageIds } = await withCreationTime(at, () =>
			seedThread(
				t,
				mailboxId,
				folders,
				Array.from({ length: 250 }, () => ({ receivedAt: at }))
			)
		);

		const calls = await archiveUntilDone([threadId]);

		expect(calls.map((call) => call.threads[0]!.moved)).toEqual([100, 100, 50]);
		expect(calls[0]!.threads[0]!.from).toEqual({ receivedAt: at, creationTime: at });
		expect(calls[calls.length - 1]!.threads[0]).toMatchObject({ isDone: true, hasLeftInbox: true });
		expect(new Set(calls.flatMap((call) => call.moved.map((m) => m.messageId))).size).toBe(250);
		for (const id of messageIds) expect(await folderOf(t, id)).toBe(folders.archive);
	});

	it('skips snoozed mail inside such a tie again on resuming, and archives the rest', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const at = Date.now() - 60_000;
		const later = Date.now() + 86_400_000;
		const { threadId, messageIds } = await withCreationTime(at, () =>
			seedThread(t, mailboxId, folders, [
				...Array.from({ length: 100 }, () => ({ receivedAt: at })),
				...Array.from({ length: 5 }, () => ({ receivedAt: at, snoozedUntil: later })),
				...Array.from({ length: 50 }, () => ({ receivedAt: at })),
			])
		);

		const calls = await archiveUntilDone([threadId]);

		expect(calls.map((call) => call.threads[0]!.moved)).toEqual([100, 50]);
		expect(calls[1]!.threads[0]).toMatchObject({ isDone: true, hasLeftInbox: false });
		for (const [i, id] of messageIds.entries()) {
			const snoozed = i >= 100 && i < 105;
			expect(await folderOf(t, id)).toBe(snoozed ? folders.inbox : folders.archive);
		}
	});

	it('stops, rather than looping, at more snoozed mail on one timestamp pair than a call reads', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const at = Date.now() - 60_000;
		const later = Date.now() + 86_400_000;
		const { threadId } = await withCreationTime(at, () =>
			seedThread(t, mailboxId, folders, [
				...Array.from({ length: 2001 }, () => ({ receivedAt: at, snoozedUntil: later })),
				{ receivedAt: at },
			])
		);

		const calls = await archiveUntilDone([threadId]);

		// The first call stops at the tie; the second re-reads it from there and gives up.
		expect(calls.map((call) => call.threads[0])).toEqual([
			expect.objectContaining({ moved: 0, isDone: false }),
			expect.objectContaining({ moved: 0, isDone: true, hasLeftInbox: false }),
		]);
	});

	it('archives a 1,000-message conversation within the transaction limits, resuming between calls', async () => {
		// Enforces Convex's per-transaction limits, 4,096 index ranges among them.
		// Moving 1,000 messages in one transaction would pass that limit.
		t = convexTest({ schema, modules, transactionLimits: true });
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: 1000 }, () => ({}))
		);

		const calls = await archiveUntilDone([threadId]);

		expect(calls).toHaveLength(10);
		expect(calls[calls.length - 1]!.threads[0]).toMatchObject({ isDone: true, hasLeftInbox: true });
		const archived = await t.run(async (ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_thread_folder_received', (q) =>
					q.eq('threadId', threadId).eq('folderId', folders.archive)
				)
				.collect()
		);
		expect(archived).toHaveLength(messageIds.length);
	});

	it('archives as many conversations as one call takes within the transaction limits', async () => {
		t = convexTest({ schema, modules, transactionLimits: true });
		const { mailboxId, folders } = await seedBox(t);
		const threads = [];
		for (let i = 0; i < 100; i++) {
			threads.push(await seedThread(t, mailboxId, folders, [{}, { role: 'sent' }]));
		}

		const result = await archiveThreads(threads.map((thread) => thread.threadId));

		expect(result.moved).toHaveLength(100);
		expect(result.threads.every((outcome) => outcome.isDone && outcome.hasLeftInbox)).toBe(true);
	});
});
