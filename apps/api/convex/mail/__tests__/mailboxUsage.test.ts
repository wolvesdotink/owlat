/**
 * Mailbox storage accounting lives on the 1:1 `mailboxUsage` row (plan 2.4).
 *
 * `requireMailboxAccess` reads the mailbox document, so a delivery that patched
 * it re-ran every Postbox query for the mailbox in every open tab. These tests
 * pin that a delivery leaves the mailbox document alone, that quota checks and
 * the MTA cache push read the usage row, and that a mailbox from before the
 * split (usage only in the deprecated columns) keeps working until the
 * backfill runs.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { readMailboxUsage } from '../mailboxUsage';
import { seedFolder, seedMailbox } from './helpers.testlib';

type Test = TestConvex<typeof schema>;

const ADDRESS = 'a@owlat.test';

async function deliver(t: Test, rawSize: number, messageId: string) {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['x'])));
	return await t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize,
		recipientAddress: ADDRESS,
		from: 'sender@example.org',
		to: [ADDRESS],
		cc: [],
		bcc: [],
		subject: 'Quarterly numbers',
		textBodyInline: 'The numbers are attached.',
		snippet: 'The numbers are attached.',
		messageId,
		receivedAt: Date.now(),
		attachments: [],
		spamScore: 0,
		spamVerdict: 'ham',
	});
}

async function mailboxDoc(t: Test, mailboxId: Id<'mailboxes'>): Promise<Doc<'mailboxes'>> {
	return await t.run(async (ctx) => (await ctx.db.get(mailboxId))!);
}

async function usage(t: Test, mailboxId: Id<'mailboxes'>) {
	return await t.run(async (ctx) => await readMailboxUsage(ctx.db, (await ctx.db.get(mailboxId))!));
}

async function usageRow(t: Test, mailboxId: Id<'mailboxes'>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailboxUsage')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.unique()
	);
}

describe('mailbox usage row', () => {
	it('a delivery charges the usage row and leaves the mailbox document untouched', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: ADDRESS });
		await seedFolder(t, mailboxId, 'inbox');
		const before = await mailboxDoc(t, mailboxId);

		const first = await deliver(t, 1_200, '<usage-1@example.org>');
		const second = await deliver(t, 800, '<usage-2@example.org>');
		expect('messageId' in first && 'messageId' in second).toBe(true);

		expect(await mailboxDoc(t, mailboxId)).toEqual(before);
		expect(await usage(t, mailboxId)).toEqual({ usedBytes: 2_000, usageRevision: 2 });
	});

	it('reads and carries on from the deprecated columns before the backfill', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: ADDRESS });
		await seedFolder(t, mailboxId, 'inbox');
		// A pre-split mailbox: usage only on the mailbox document.
		await t.run((ctx) =>
			ctx.db.patch(mailboxId, { quotaBytes: 1_000, usedBytes: 900, usageRevision: 4 })
		);
		const before = await mailboxDoc(t, mailboxId);
		expect(await usageRow(t, mailboxId)).toBeNull();
		expect(await usage(t, mailboxId)).toEqual({ usedBytes: 900, usageRevision: 4 });

		// The quota check sees the legacy count: 900 + 200 is over 1000.
		expect(await deliver(t, 200, '<over@example.org>')).toEqual({ skipped: true });

		// A delivery that fits seeds the row from the legacy count.
		const accepted = await deliver(t, 50, '<fits@example.org>');
		expect('messageId' in accepted).toBe(true);
		expect(await usage(t, mailboxId)).toEqual({ usedBytes: 950, usageRevision: 5 });
		expect(await mailboxDoc(t, mailboxId)).toEqual(before);

		// From now on the row is the truth: the full mailbox refuses the next one.
		expect(await deliver(t, 60, '<full@example.org>')).toEqual({ skipped: true });
	});

	it('serves the live count to the MTA cache push and the member usage list', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: ADDRESS });
		await seedFolder(t, mailboxId, 'inbox');
		await deliver(t, 4_096, '<cache@example.org>');

		const forCache = await t.query(internal.mail.mailbox.identity.getById, { mailboxId });
		expect(forCache?.usedBytes).toBe(4_096);
		// The deprecated column is left as it was.
		expect((await mailboxDoc(t, mailboxId)).usedBytes).toBe(0);
	});

	it('the 0046 backfill creates missing rows from the columns and never overwrites one', async () => {
		const t = convexTest(schema, modules);
		const legacyId = await seedMailbox(t, { address: 'legacy@owlat.test' });
		const liveId = await seedMailbox(t, { address: ADDRESS });
		await seedFolder(t, liveId, 'inbox');
		await t.run((ctx) => ctx.db.patch(legacyId, { usedBytes: 321, usageRevision: 7 }));
		await deliver(t, 100, '<live@example.org>');

		const run = internal.migrations['0046_split_hot_rows'].run;
		expect((await t.action(run, {})).mailboxUsage).toBe(1);
		expect(await usage(t, legacyId)).toEqual({ usedBytes: 321, usageRevision: 7 });
		expect(await usage(t, liveId)).toEqual({ usedBytes: 100, usageRevision: 1 });

		expect((await t.action(run, {})).mailboxUsage).toBe(0);
	});
});
