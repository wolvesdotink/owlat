/**
 * Whole-folder "Mark all as read" and "Empty Trash / Spam".
 *
 * The properties that matter are the edges of "all": every unread message up
 * to the moment of the click, across as many batches as it takes, and nothing
 * that arrived afterwards, nothing snoozed, nothing in another folder. Emptying
 * is limited to Trash and Spam and, on a team inbox, to its owners.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import {
	modules,
	seedMailbox,
	seedFolder,
	seedMessage,
	type SeededFolderRole,
} from './helpers.testlib';
import { MARK_FOLDER_READ_BATCH, EMPTY_FOLDER_BATCH } from '../folderBulk';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Seed `count` messages into the mailbox's `role` folder with distinct uids
 * and the folder counters a real delivery leaves behind.
 */
async function seedMessages(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole,
	count: number,
	seed: { flagSeen?: boolean; subjectPrefix?: string } = {}
): Promise<Id<'mailMessages'>[]> {
	const ids: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) {
		ids.push(
			await seedMessage(t, mailboxId, {
				role,
				subject: `${seed.subjectPrefix ?? role}-${i}`,
				flagSeen: seed.flagSeen ?? false,
			})
		);
	}
	await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (!folder) throw new Error(`folder ${role} missing`);
		let uid = folder.uidNext;
		for (const id of ids) {
			const message = await ctx.db.get(id);
			await ctx.db.patch(id, { uid: uid++ });
			if (message?.flagSeen) {
				await ctx.db.patch(message.threadId, { unreadCount: 0 });
			}
		}
		await ctx.db.patch(folder._id, {
			uidNext: uid,
			totalCount: folder.totalCount + ids.length,
			unseenCount: folder.unseenCount + (seed.flagSeen ? 0 : ids.length),
		});
	});
	return ids;
}

async function folderOf(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole
) {
	return await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (!folder) throw new Error(`folder ${role} missing`);
		return folder;
	});
}

async function unreadIds(
	t: TestConvex<typeof schema>,
	folderId: Id<'mailFolders'>
): Promise<Id<'mailMessages'>[]> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_seen', (q) => q.eq('folderId', folderId).eq('flagSeen', false))
			.collect();
		return rows.map((row) => row._id);
	});
}

async function countIn(t: TestConvex<typeof schema>, folderId: Id<'mailFolders'>): Promise<number> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
			.collect();
		return rows.length;
	});
}

/** Drive `markFolderRead` the way the client does, returning every id it flipped. */
async function markAllRead(
	t: TestConvex<typeof schema>,
	folderId: Id<'mailFolders'>,
	betweenBatches?: () => Promise<void>
): Promise<{ markedIds: Id<'mailMessages'>[]; calls: number }> {
	const markedIds: Id<'mailMessages'>[] = [];
	let cursor: { ceilingUid: number; afterUid: number } | null = null;
	let calls = 0;
	for (;;) {
		const answer: { markedIds: Id<'mailMessages'>[]; ceilingUid: number; afterUid: number | null } =
			await t.mutation(api.mail.folderBulk.markFolderRead, { folderId, ...(cursor ?? {}) });
		calls++;
		markedIds.push(...answer.markedIds);
		if (answer.afterUid === null) break;
		cursor = { ceilingUid: answer.ceilingUid, afterUid: answer.afterUid };
		await betweenBatches?.();
	}
	return { markedIds, calls };
}

async function seedPersonal(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	for (const role of ['inbox', 'archive', 'trash', 'spam'] as const) {
		await seedFolder(t, mailboxId, role);
	}
	return mailboxId;
}

describe('markFolderRead', () => {
	it('marks every unread message in the folder across batches, and nothing elsewhere', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const inboxIds = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 5);
		const archiveIds = await seedMessages(t, mailboxId, 'archive', 2);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { markedIds, calls } = await markAllRead(t, inbox._id);

		expect(calls).toBe(2);
		expect(new Set(markedIds)).toEqual(new Set(inboxIds));
		expect(await unreadIds(t, inbox._id)).toEqual([]);
		expect((await folderOf(t, mailboxId, 'inbox')).unseenCount).toBe(0);
		const archive = await folderOf(t, mailboxId, 'archive');
		expect(new Set(await unreadIds(t, archive._id))).toEqual(new Set(archiveIds));
		expect(archive.unseenCount).toBe(2);
	});

	it('leaves mail that arrived after the first batch unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		let late: Id<'mailMessages'>[] = [];
		await markAllRead(t, inbox._id, async () => {
			late = await seedMessages(t, mailboxId, 'inbox', 1, { subjectPrefix: 'late' });
		});

		expect(await unreadIds(t, inbox._id)).toEqual(late);
	});

	it('skips snoozed messages so they come back unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const [snoozed, plain] = await seedMessages(t, mailboxId, 'inbox', 2);
		await t.run(async (ctx) => {
			await ctx.db.patch(snoozed!, { snoozedUntil: Date.now() + 60 * 60 * 1000 });
		});
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { markedIds } = await markAllRead(t, inbox._id);

		expect(markedIds).toEqual([plain]);
		expect(await unreadIds(t, inbox._id)).toEqual([snoozed]);
	});

	it('refuses a folder the caller cannot access', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';

		await expect(
			t.mutation(api.mail.folderBulk.markFolderRead, { folderId: inbox._id })
		).rejects.toThrow();
		expect(await unreadIds(t, inbox._id)).toHaveLength(1);
	});
});

describe('emptyFolder', () => {
	it('deletes everything in Trash, continuing on the scheduler', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'trash', EMPTY_FOLDER_BATCH + 3, { flagSeen: true });
		await seedMessages(t, mailboxId, 'inbox', 1);
		const trash = await folderOf(t, mailboxId, 'trash');

		const first = await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id });
		expect(first).toEqual({ purged: EMPTY_FOLDER_BATCH, more: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await countIn(t, trash._id)).toBe(0);
		expect((await folderOf(t, mailboxId, 'trash')).totalCount).toBe(0);
		expect(await countIn(t, (await folderOf(t, mailboxId, 'inbox'))._id)).toBe(1);
	});

	it('empties Spam too', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'spam', 2);
		const spam = await folderOf(t, mailboxId, 'spam');

		await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: spam._id });

		expect(await countIn(t, spam._id)).toBe(0);
	});

	it('refuses any folder other than Trash and Spam', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		await expect(
			t.mutation(api.mail.folderBulk.emptyFolder, { folderId: inbox._id })
		).rejects.toThrow(/Trash and Spam/);
		expect(await countIn(t, inbox._id)).toBe(1);
	});

	it("needs the owner role on a team inbox's Trash", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'user-A',
			scope: 'shared',
			address: 'support@owlat.test',
		});
		await seedFolder(t, mailboxId, 'trash');
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [authUserId, role] of [
				['user-A', 'owner'],
				['user-B', 'member'],
			] as const) {
				await ctx.db.insert('mailboxMembers', {
					mailboxId,
					authUserId,
					role,
					addedBy: 'user-A',
					createdAt: now,
				});
			}
		});
		await seedMessages(t, mailboxId, 'trash', 1);
		const trash = await folderOf(t, mailboxId, 'trash');

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(
			t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id })
		).rejects.toThrow(/permission/);
		expect(await countIn(t, trash._id)).toBe(1);

		sessionMocks.userId = 'user-A';
		await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id });
		expect(await countIn(t, trash._id)).toBe(0);
	});
});
