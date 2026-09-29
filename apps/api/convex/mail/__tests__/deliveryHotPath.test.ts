/**
 * Delivery hot-path writes and reads (plan C10).
 *
 *   - The Reply Queue's pending marker is stamped in the insert's own thread
 *     patch, so a live inbox delivery patches its thread once, not once for the
 *     aggregates and again for `needsReplyPendingAt`. The requeue path
 *     (`enqueueNeedsReplyCheck`) still stamps it itself.
 *   - The Message-ID dedup and the In-Reply-To/References walk seek
 *     `by_mailbox_and_rfc822_message_id`: a Message-ID that sits in many
 *     mailboxes (a list post, an all-hands mail) is no longer read out of
 *     every one of them and filtered down to this mailbox.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { findDuplicateInMailbox, insertDeliveredMessage } from '../deliveryPipeline/insert';
import type { InboundOrigin } from '../deliveryPipeline/afterInsert';
import { runPostInsertInboundEffects } from '../deliveryPipeline/afterInsert';
import { resolveDeliveryThread } from '../deliveryPipeline/threading';
import { enqueueNeedsReplyCheck } from '../needsReply';
import { recordingDb, type IndexSeek } from '../../__tests__/indexRecorder.testlib';
import { modules, seedFolder, seedMailbox } from './helpers.testlib';

type T = TestConvex<typeof schema>;
/** The `t.run` context: a mutation context whose storage can also `store`. */
type RunCtx = Parameters<Parameters<T['run']>[0]>[0];

afterEach(() => {
	vi.useRealTimers();
});

async function inboxOf(ctx: MutationCtx, mailboxId: Id<'mailboxes'>): Promise<Doc<'mailFolders'>> {
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
		.first();
	if (!folder) throw new Error('no inbox');
	return folder;
}

async function deliver(
	ctx: RunCtx,
	mailboxId: Id<'mailboxes'>,
	opts: { messageId: string; inReplyTo?: string; inboundOrigin?: InboundOrigin }
): Promise<Id<'mailMessages'>> {
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox) throw new Error('no mailbox');
	return await insertDeliveredMessage(ctx, {
		mailbox,
		folder: await inboxOf(ctx, mailboxId),
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
		rawSize: 3,
		from: 'Sam <sam@acme.test>',
		to: [mailbox.address],
		cc: [],
		bcc: [],
		subject: opts.inReplyTo ? 'Re: Friday?' : 'Friday?',
		textBodyInline: 'Can you confirm Friday works?',
		messageId: opts.messageId,
		inReplyTo: opts.inReplyTo,
		receivedAt: Date.now(),
		attachments: [],
		inboundOrigin: opts.inboundOrigin,
	});
}

async function scheduledNames(t: T): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

describe('Reply Queue pending marker rides the insert thread patch', () => {
	it('a live inbox delivery patches its thread once and still schedules the classify', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const { threadPatches, thread } = await t.run(async (ctx) => {
			const patch = vi.spyOn(ctx.db, 'patch');
			const messageId = await deliver(ctx, mailboxId, {
				messageId: '<m1@acme.test>',
				inboundOrigin: 'mx',
			});
			const message = (await ctx.db.get(messageId))!;
			await runPostInsertInboundEffects(ctx, {
				messageId,
				folder: await inboxOf(ctx, mailboxId),
				origin: 'mx',
			});
			const threadPatches = patch.mock.calls.filter(([id]) => id === message.threadId).length;
			patch.mockRestore();
			return { threadPatches, thread: (await ctx.db.get(message.threadId))! };
		});

		expect(threadPatches).toBe(1);
		expect(thread.needsReplyPendingAt).toBe(thread.updatedAt);
		expect(await scheduledNames(t)).toEqual(
			expect.arrayContaining([expect.stringContaining('needsReplyClassify')])
		);
	});

	it('an insert without an inbound origin (archive import, brief) stamps nothing', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const pending = await t.run(async (ctx) => {
			const messageId = await deliver(ctx, mailboxId, { messageId: '<m1@acme.test>' });
			const message = (await ctx.db.get(messageId))!;
			return (await ctx.db.get(message.threadId))!.needsReplyPendingAt ?? null;
		});
		expect(pending).toBeNull();
	});

	it('a backfill insert stamps nothing', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const pending = await t.run(async (ctx) => {
			const messageId = await deliver(ctx, mailboxId, {
				messageId: '<m1@acme.test>',
				inboundOrigin: 'backfill',
			});
			const message = (await ctx.db.get(messageId))!;
			return (await ctx.db.get(message.threadId))!.needsReplyPendingAt ?? null;
		});
		expect(pending).toBeNull();
	});

	it('the requeue path still stamps the marker itself', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const pending = await t.run(async (ctx) => {
			const messageId = await deliver(ctx, mailboxId, { messageId: '<m1@acme.test>' });
			const { threadId } = (await ctx.db.get(messageId))!;
			await enqueueNeedsReplyCheck(ctx, threadId);
			return (await ctx.db.get(threadId))!.needsReplyPendingAt;
		});
		expect(pending).toEqual(expect.any(Number));
		expect(await scheduledNames(t)).toEqual([expect.stringContaining('needsReplyClassify')]);
	});
});

describe('Message-ID lookups seek one mailbox', () => {
	/** Two mailboxes that both hold `<shared@acme.test>`, each in its own thread. */
	async function twoMailboxesSharingAMessageId(t: T) {
		const mine = await seedMailbox(t, { address: 'me@owlat.test', userId: 'user-A' });
		const theirs = await seedMailbox(t, { address: 'them@owlat.test', userId: 'user-B' });
		await seedFolder(t, mine, 'inbox');
		await seedFolder(t, theirs, 'inbox');
		return await t.run(async (ctx) => {
			// The other mailbox's copy lands first, so a global-index `.first()`
			// without the mailbox filter would pick it.
			const theirCopy = await deliver(ctx, theirs, { messageId: '<shared@acme.test>' });
			const myCopy = await deliver(ctx, mine, { messageId: '<shared@acme.test>' });
			return { mine, theirs, myCopy, theirCopy };
		});
	}

	it('the dedup finds this mailbox copy through the per-mailbox index', async () => {
		const t = convexTest(schema, modules);
		const { mine, myCopy } = await twoMailboxesSharingAMessageId(t);

		const { found, seeks } = await t.run(async (ctx) => {
			const seeks: IndexSeek[] = [];
			const found = await findDuplicateInMailbox(
				{ db: recordingDb(ctx.db, seeks) },
				mine,
				'<shared@acme.test>'
			);
			return { found: found?._id ?? null, seeks };
		});

		expect(found).toBe(myCopy);
		expect(seeks).toEqual([
			{
				table: 'mailMessages',
				index: 'by_mailbox_and_rfc822_message_id',
				range: [
					['eq', 'mailboxId', mine],
					['eq', 'rfc822MessageId', 'shared@acme.test'],
				],
			},
		]);
	});

	it('the dedup misses a Message-ID only another mailbox holds', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedMailbox(t, { address: 'me@owlat.test', userId: 'user-A' });
		const theirs = await seedMailbox(t, { address: 'them@owlat.test', userId: 'user-B' });
		await seedFolder(t, theirs, 'inbox');
		const found = await t.run(async (ctx) => {
			await deliver(ctx, theirs, { messageId: '<only-theirs@acme.test>' });
			return await findDuplicateInMailbox(ctx, mine, '<only-theirs@acme.test>');
		});
		expect(found).toBeNull();
	});

	it('the References walk joins this mailbox thread through the per-mailbox index', async () => {
		const t = convexTest(schema, modules);
		const { mine, myCopy } = await twoMailboxesSharingAMessageId(t);

		const { threadId, expected, seeks } = await t.run(async (ctx) => {
			const seeks: IndexSeek[] = [];
			const mailbox = (await ctx.db.get(mine))!;
			const threadId = await resolveDeliveryThread(
				{ ...ctx, db: recordingDb(ctx.db, seeks) },
				{
					mailbox,
					messageId: 'reply@acme.test',
					rootId: 'shared@acme.test',
					references: ['shared@acme.test'],
					subject: 'Re: Friday?',
					normalizedSubject: 'friday?',
					receivedAt: Date.now(),
					parties: ['sam@acme.test', 'me@owlat.test'],
				}
			);
			return { threadId, expected: (await ctx.db.get(myCopy))!.threadId, seeks };
		});

		expect(threadId).toBe(expected);
		expect(seeks[0]).toEqual({
			table: 'mailMessages',
			index: 'by_mailbox_and_rfc822_message_id',
			range: [
				['eq', 'mailboxId', mine],
				['eq', 'rfc822MessageId', 'shared@acme.test'],
			],
		});
		expect(seeks.map((s) => s.index)).not.toContain('by_rfc822_message_id');
	});
});
