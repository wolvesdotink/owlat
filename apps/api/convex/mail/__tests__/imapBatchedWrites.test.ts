/**
 * The backend half of batched IMAP writes (`mail/imap/move.ts`).
 *
 * Convex caps an array argument at 8,192 elements, so the IMAP server sends a
 * large UID EXPUNGE set in batches, highest UIDs first, and threads the cursor
 * `expungeFolder` returns into the call for the next batch. That only works if
 * the walk for one batch stops at the batch's lowest UID and hands back its
 * cursor on the last page too. A large COPY also goes out in batches, and
 * `discardCopies` undoes the batches that did commit when a later one fails.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';

type Test = TestConvex<typeof schema>;

/** Seed `uids.length` messages into the inbox with those UIDs, all \Deleted. */
async function seedInbox(t: Test, uids: number[]) {
	const mailboxId = await seedMailbox(t);
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	const archiveId = await seedFolder(t, mailboxId, 'archive');
	const ids: Id<'mailMessages'>[] = [];
	for (const uid of uids) {
		const id = await seedMessage(t, mailboxId, { subject: `m${uid}`, flagSeen: true });
		await t.run((ctx) => ctx.db.patch(id, { uid, flagDeleted: true }));
		ids.push(id);
	}
	await t.run((ctx) =>
		ctx.db.patch(inboxId, { totalCount: uids.length, uidNext: Math.max(...uids) + 1 })
	);
	return { mailboxId, inboxId, archiveId, ids };
}

async function folderUids(t: Test, folderId: Id<'mailFolders'>): Promise<number[]> {
	return t.run(async (ctx) =>
		(
			await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
				.collect()
		).map((m) => m.uid)
	);
}

describe('expungeFolder with a UID set', () => {
	it('stops at the lowest UID of the set and returns the cursor for the next batch', async () => {
		const t = convexTest(schema, modules);
		const { inboxId } = await seedInbox(t, [1, 2, 3, 4, 5]);

		const first = await t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId: inboxId,
			uidSet: [4, 5],
			imapWireVersion: IMAP_WIRE_VERSION,
		});
		expect(first.uids).toEqual([5, 4]);
		expect(first.done).toBe(true);
		// The walk ended at UID 4; UIDs 1-3 are still there.
		expect(first.beforeUid).toBe(4);

		const second = await t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId: inboxId,
			uidSet: [1, 2],
			beforeUid: first.beforeUid,
			imapWireVersion: IMAP_WIRE_VERSION,
		});
		expect(second.uids).toEqual([2, 1]);
		expect(await folderUids(t, inboxId)).toEqual([3]);
	});

	it('still walks the whole folder for a bare EXPUNGE', async () => {
		const t = convexTest(schema, modules);
		const { inboxId } = await seedInbox(t, [1, 2, 3]);

		const result = await t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId: inboxId,
			imapWireVersion: IMAP_WIRE_VERSION,
		});
		expect(result.uids).toEqual([3, 2, 1]);
		expect(result.done).toBe(true);
		expect(await folderUids(t, inboxId)).toEqual([]);
	});

	it('refuses a v0.6.8 or older IMAP server before deleting and serves wire 2', async () => {
		const t = convexTest(schema, modules);
		const { inboxId } = await seedInbox(t, [1, 2]);

		// v0.6.7 and older send no wire version and paged on the removed
		// `nextSequenceNumber`; v0.6.8 speaks wire 1, which the backend no
		// longer serves. Nothing is deleted for either.
		await expect(
			t.mutation(internal.mail.imap.move.expungeFolder, { folderId: inboxId })
		).rejects.toThrow(/Update the IMAP container/);
		await expect(
			t.mutation(internal.mail.imap.move.expungeFolder, { folderId: inboxId, imapWireVersion: 1 })
		).rejects.toThrow(/wire version 1/);
		expect(await folderUids(t, inboxId)).toEqual([1, 2]);

		// Wire 2, the release one behind, is served.
		const result = await t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId: inboxId,
			imapWireVersion: 2,
		});
		expect(result.uids).toEqual([2, 1]);
		expect(await folderUids(t, inboxId)).toEqual([]);
	});

	it('answers a folder that is gone with an empty page', async () => {
		const t = convexTest(schema, modules);
		const { inboxId } = await seedInbox(t, [1]);
		await t.run((ctx) => ctx.db.delete(inboxId));

		const result = await t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId: inboxId,
			imapWireVersion: IMAP_WIRE_VERSION,
		});
		expect(result).toEqual({ uids: [], modseq: 0, done: true });
	});
});

describe('discardCopies', () => {
	it('removes the listed copies and restores the target folder and mailbox counters', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId, archiveId, ids } = await seedInbox(t, [1, 2, 3]);
		const before = await t.run(async (ctx) => ({
			archive: await ctx.db.get(archiveId),
			mailbox: await ctx.db.get(mailboxId),
		}));

		const copied = await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: inboxId,
			targetFolderId: archiveId,
			messageIds: ids.slice(0, 2),
		});
		expect(copied.pairs).toHaveLength(2);

		const result = await t.mutation(internal.mail.imap.move.discardCopies, {
			targetFolderId: archiveId,
			uids: copied.pairs.map((p) => p.targetUid),
		});
		expect(result.removed).toBe(2);
		expect(await folderUids(t, archiveId)).toEqual([]);
		expect(await folderUids(t, inboxId)).toEqual([1, 2, 3]);

		const after = await t.run(async (ctx) => ({
			archive: await ctx.db.get(archiveId),
			mailbox: await ctx.db.get(mailboxId),
			sourceBlob: (await ctx.storage.get((await ctx.db.get(ids[0]!))!.rawStorageId)) !== null,
		}));
		expect(after.archive?.totalCount).toBe(before.archive?.totalCount);
		expect(after.archive?.unseenCount).toBe(before.archive?.unseenCount);
		expect(after.mailbox?.usedBytes).toBe(before.mailbox?.usedBytes);
		// The source rows share the blobs; they must survive the discard.
		expect(after.sourceBlob).toBe(true);
		// A removal still moves the folder's modseq forward for CONDSTORE clients.
		expect(after.archive!.highestModseq).toBeGreaterThan(before.archive!.highestModseq);
	});

	it('leaves rows it was not asked to remove', async () => {
		const t = convexTest(schema, modules);
		const { inboxId, archiveId, ids } = await seedInbox(t, [1, 2]);
		const copied = await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: inboxId,
			targetFolderId: archiveId,
			messageIds: ids,
		});
		const [kept, discarded] = copied.pairs;

		await t.mutation(internal.mail.imap.move.discardCopies, {
			targetFolderId: archiveId,
			uids: [discarded!.targetUid, 999_999],
		});
		expect(await folderUids(t, archiveId)).toEqual([kept!.targetUid]);
	});
});
