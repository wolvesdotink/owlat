/**
 * `mailboxes.usedBytes` across an IMAP COPY.
 *
 * Both delete paths decrement one row's `rawSize` unconditionally
 * (`purgeMessageRow`, `expungeFolder`), so COPY had to charge it — otherwise a
 * copy-then-expunge cycle walks the counter down permanently and a mailbox that
 * holds mail reports less and less of it. The counter is what the MTA's
 * over-quota recipient gate reads (`apps/mta/src/bounce/recipientGate.ts`), so
 * it drifting low silently widens whatever quota an operator did set.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { purgeMessageRow } from '../messagePurge';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

type Test = TestConvex<typeof schema>;

async function usedBytes(t: Test, mailboxId: Id<'mailboxes'>): Promise<number> {
	return t.run(async (ctx) => (await ctx.db.get(mailboxId))?.usedBytes ?? -1);
}

describe('mailbox usedBytes across IMAP COPY', () => {
	it('charges the copy and gives the bytes back when either row is destroyed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const inboxId = await seedFolder(t, mailboxId, 'inbox');
		const archiveId = await seedFolder(t, mailboxId, 'archive');
		const messageId = await seedMessage(t, mailboxId, { subject: 'billable' });
		const rawSize = await t.run(async (ctx) => (await ctx.db.get(messageId))?.rawSize ?? 0);
		// Model the state delivery would have left: the one row is already charged.
		await t.run(async (ctx) => ctx.db.patch(mailboxId, { usedBytes: rawSize }));

		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: inboxId,
			targetFolderId: archiveId,
			messageIds: [messageId],
		});
		expect(await usedBytes(t, mailboxId)).toBe(rawSize * 2);

		// Expunge the copy — the decrement the COPY now has an increment to match.
		const copyId = await t.run(async (ctx) => {
			const copy = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', archiveId))
				.first();
			if (!copy) throw new Error('COPY produced no row');
			await ctx.db.patch(copy._id, { flagDeleted: true });
			return copy._id;
		});
		await t.mutation(internal.mail.imap.move.expungeFolder, { folderId: archiveId });
		expect(await t.run(async (ctx) => ctx.db.get(copyId))).toBeNull();
		expect(await usedBytes(t, mailboxId)).toBe(rawSize);

		// And the original brings it back to zero, not below it.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			if (!m) throw new Error('original vanished');
			await purgeMessageRow(ctx, m);
		});
		expect(await usedBytes(t, mailboxId)).toBe(0);
	});
});
