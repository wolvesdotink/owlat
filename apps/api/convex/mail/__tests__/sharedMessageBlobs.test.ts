/**
 * IMAP COPY shares one storage blob between two `mailMessages` rows — the copy
 * is a new row spreading the SAME `rawStorageId`/`textBodyStorageId`/
 * `htmlBodyStorageId` (`mail/imap/move.ts` copyMessages). Every path that
 * destroys a message row used to delete those blobs unconditionally, so purging
 * or expunging EITHER row left the surviving sibling listed but unreadable: raw
 * MIME gone, body gone, attachments gone, permanently.
 *
 * These tests pin both halves of the contract that `deleteMessageRowAndBlobs`
 * (`mail/messagePurge.ts`) now owns:
 *   1. a sibling survives its twin's destruction with every blob intact, and
 *   2. the blob IS freed once the LAST row referencing it goes — a refcount that
 *      leaks storage forever would only trade one bug for another.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { purgeMessageRow } from '../messagePurge';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

type Test = TestConvex<typeof schema>;

/** Give the seeded message the two optional body blobs COPY also shares. */
async function attachBodyBlobs(
	t: Test,
	messageId: Id<'mailMessages'>
): Promise<{ textBodyStorageId: Id<'_storage'>; htmlBodyStorageId: Id<'_storage'> }> {
	return t.run(async (ctx) => {
		const textBodyStorageId = await ctx.storage.store(new Blob(['text body']));
		const htmlBodyStorageId = await ctx.storage.store(new Blob(['<p>html body</p>']));
		await ctx.db.patch(messageId, { textBodyStorageId, htmlBodyStorageId });
		return { textBodyStorageId, htmlBodyStorageId };
	});
}

/** Seed a mailbox with an inbox + archive folder and one message in the inbox. */
async function setup(t: Test) {
	const mailboxId = await seedMailbox(t);
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	const archiveId = await seedFolder(t, mailboxId, 'archive');
	const messageId = await seedMessage(t, mailboxId, { subject: 'shared-blob' });
	const bodies = await attachBodyBlobs(t, messageId);
	const rawStorageId = await t.run(async (ctx) => {
		const m = await ctx.db.get(messageId);
		if (!m) throw new Error('seeded message vanished');
		return m.rawStorageId;
	});
	return { mailboxId, inboxId, archiveId, messageId, rawStorageId, ...bodies };
}

/** The row IMAP COPY created in `archiveId` (the seeded original stays in the inbox). */
async function copiedRow(t: Test, archiveId: Id<'mailFolders'>) {
	return t.run(async (ctx) => {
		const copy = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', archiveId))
			.first();
		if (!copy) throw new Error('COPY produced no row');
		return copy;
	});
}

async function blobExists(t: Test, storageId: Id<'_storage'>): Promise<boolean> {
	return t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null);
}

/** Destroy one row through the same helper the "Delete forever" mutation uses. */
async function purge(t: Test, messageId: Id<'mailMessages'>): Promise<void> {
	await t.run(async (ctx) => {
		const m = await ctx.db.get(messageId);
		if (!m) throw new Error('message already gone');
		await purgeMessageRow(ctx, m);
	});
}

describe('storage blobs shared by an IMAP COPY', () => {
	it('keeps the surviving sibling readable when the copy is purged', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);

		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: s.inboxId,
			targetFolderId: s.archiveId,
			messageIds: [s.messageId],
		});
		const copy = await copiedRow(t, s.archiveId);
		expect(copy.rawStorageId).toBe(s.rawStorageId);
		expect(copy.textBodyStorageId).toBe(s.textBodyStorageId);

		await purge(t, copy._id);

		// The original is still listed — and its bytes must still be there.
		expect(await t.run(async (ctx) => ctx.db.get(s.messageId))).not.toBeNull();
		expect(await blobExists(t, s.rawStorageId)).toBe(true);
		expect(await blobExists(t, s.textBodyStorageId)).toBe(true);
		expect(await blobExists(t, s.htmlBodyStorageId)).toBe(true);
	});

	it('keeps the copy readable when the ORIGINAL is purged', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);

		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: s.inboxId,
			targetFolderId: s.archiveId,
			messageIds: [s.messageId],
		});
		const copy = await copiedRow(t, s.archiveId);

		await purge(t, s.messageId);

		expect(await t.run(async (ctx) => ctx.db.get(copy._id))).not.toBeNull();
		expect(await blobExists(t, s.rawStorageId)).toBe(true);
		expect(await blobExists(t, s.textBodyStorageId)).toBe(true);
		expect(await blobExists(t, s.htmlBodyStorageId)).toBe(true);
	});

	it('frees every blob once the LAST referencing row is purged', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);

		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: s.inboxId,
			targetFolderId: s.archiveId,
			messageIds: [s.messageId],
		});
		const copy = await copiedRow(t, s.archiveId);

		await purge(t, copy._id);
		await purge(t, s.messageId);

		expect(await blobExists(t, s.rawStorageId)).toBe(false);
		expect(await blobExists(t, s.textBodyStorageId)).toBe(false);
		expect(await blobExists(t, s.htmlBodyStorageId)).toBe(false);
	});

	it('frees the blobs of an unshared message on a plain purge', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);

		await purge(t, s.messageId);

		expect(await blobExists(t, s.rawStorageId)).toBe(false);
		expect(await blobExists(t, s.textBodyStorageId)).toBe(false);
		expect(await blobExists(t, s.htmlBodyStorageId)).toBe(false);
	});

	it('leaves the sibling readable when the copy is EXPUNGEd, and frees the blobs on the last expunge', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);

		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: s.inboxId,
			targetFolderId: s.archiveId,
			messageIds: [s.messageId],
		});
		const copy = await copiedRow(t, s.archiveId);
		await t.run(async (ctx) => {
			await ctx.db.patch(copy._id, { flagDeleted: true });
			await ctx.db.patch(s.messageId, { flagDeleted: true });
		});

		await t.mutation(internal.mail.imap.move.expungeFolder, { folderId: s.archiveId });

		expect(await t.run(async (ctx) => ctx.db.get(copy._id))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get(s.messageId))).not.toBeNull();
		expect(await blobExists(t, s.rawStorageId)).toBe(true);
		expect(await blobExists(t, s.textBodyStorageId)).toBe(true);

		await t.mutation(internal.mail.imap.move.expungeFolder, { folderId: s.inboxId });

		expect(await blobExists(t, s.rawStorageId)).toBe(false);
		// EXPUNGE used to delete the raw blob only, leaking both body blobs.
		expect(await blobExists(t, s.textBodyStorageId)).toBe(false);
		expect(await blobExists(t, s.htmlBodyStorageId)).toBe(false);
	});
});
