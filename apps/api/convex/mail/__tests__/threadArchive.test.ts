/**
 * archiveThreads: archive whole conversations from the all-inboxes list.
 *
 * What it must get right: every Inbox copy of each thread moves (not just the
 * newest message), nothing outside the Inbox moves, each mailbox's mail lands
 * in that mailbox's own Archive, a mailbox the caller cannot reach is left
 * alone, and the returned provenance is enough for the usual move-back Undo.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, type SeededFolderRole } from './helpers.testlib';

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

type Spec = { role?: SeededFolderRole; snoozedUntil?: number };

/** One thread with a message per spec, 1 s apart, folder counters kept consistent. */
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
			const receivedAt = base + i * 1000;
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

		const result = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threadIds: [threadId],
		});

		expect(result.moved.map((m) => m.messageId).sort()).toEqual(
			[messageIds[0]!, messageIds[2]!].sort()
		);
		expect(result.moved.every((m) => m.sourceFolderId === folders.inbox)).toBe(true);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.archive);
		expect(await folderOf(t, messageIds[1]!)).toBe(folders.sent);
		expect(await folderOf(t, messageIds[2]!)).toBe(folders.archive);
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread!.folderRoles).not.toContain('inbox');
	});

	it("files each mailbox's threads in that mailbox's own Archive, in one call", async () => {
		const a = await seedBox(t, 'user-A', 'me@owlat.test');
		const b = await seedBox(t, 'user-A', 'other@owlat.test');
		const inA = await seedThread(t, a.mailboxId, a.folders, [{}]);
		const inB = await seedThread(t, b.mailboxId, b.folders, [{}, {}]);

		const result = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threadIds: [inA.threadId, inB.threadId],
		});

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

		const result = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threadIds: [threadId],
		});

		expect(result.moved.map((m) => m.messageId)).toEqual([messageIds[1]]);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.inbox);
	});

	it('skips a thread in a mailbox the caller cannot reach', async () => {
		const mine = await seedBox(t);
		// Another organization's mailbox: no role reaches it.
		const theirs = await seedBox(t, 'user-B', 'b@owlat.test', 'org-2');
		const own = await seedThread(t, mine.mailboxId, mine.folders, [{}]);
		const foreign = await seedThread(t, theirs.mailboxId, theirs.folders, [{}]);

		const result = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threadIds: [foreign.threadId, own.threadId],
		});

		expect(result.moved.map((m) => m.messageId)).toEqual(own.messageIds);
		expect(await folderOf(t, foreign.messageIds[0]!)).toBe(theirs.folders.inbox);
	});

	it('returns provenance the move-back Undo can restore from', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [{}, {}]);
		const { moved } = await t.mutation(api.mail.threadArchive.archiveThreads, {
			threadIds: [threadId],
		});

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
				threadIds: Array.from({ length: 101 }, () => threadId),
			})
		).rejects.toThrow(/At most 100/);
		expect(await folderOf(t, messageIds[0]!)).toBe(folders.inbox);
	});

	it('does nothing for an empty list or a thread with no Inbox mail', async () => {
		const { mailboxId, folders } = await seedBox(t);
		const { threadId } = await seedThread(t, mailboxId, folders, [{ role: 'sent' }]);

		expect(
			(await t.mutation(api.mail.threadArchive.archiveThreads, { threadIds: [] })).moved
		).toEqual([]);
		expect(
			(await t.mutation(api.mail.threadArchive.archiveThreads, { threadIds: [threadId] })).moved
		).toEqual([]);
	});
});
