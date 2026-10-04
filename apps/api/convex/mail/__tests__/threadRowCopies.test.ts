/**
 * The thread-row copies behind the Postbox conversation list and the Reply
 * Queue (plan C8).
 *
 *   - `mailThreads.latestSnoozedUntil` lets `listThreads` hide a snoozed thread
 *     without loading its newest message. Every snooze writer, the delivery
 *     insert and the aggregate rebuild keep it in step; a thread without it
 *     falls back to the message.
 *   - `needsReply.trigger` lets `listQueue` serve a row without loading the
 *     trigger message. `applyResult` writes it; the read falls back to the
 *     message when it is missing or the trigger is no longer the newest.
 *   - `listThreads` rows are projected and `listQueue` rows say only whether a
 *     draft exists; the draft is read per thread with `getDraftSlot`.
 *   - migration 0047 fills both copies on old rows.
 *
 * "Reads the copy, not the message" is pinned by making the two disagree.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { insertDeliveredMessage } from '../deliveryPipeline/insert';
import { rebuildThreadAggregates } from '../threadAggregates';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: 'user-A', role: 'owner' })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: 'user-A',
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'user-A',
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
	};
});

const HOUR = 60 * 60 * 1000;

type T = TestConvex<typeof schema>;

async function setup(): Promise<{ t: T; mailboxId: Id<'mailboxes'> }> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	await seedFolder(t, mailboxId, 'inbox');
	return { t, mailboxId };
}

/** One inbox message whose thread points at it, as a delivery leaves it. */
async function seedConversation(
	t: T,
	mailboxId: Id<'mailboxes'>,
	subject = 'hello'
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	const messageId = await seedMessage(t, mailboxId, { subject, fromName: 'Ann' });
	const threadId = await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		await ctx.db.patch(message.threadId, { latestMessageId: messageId });
		return message.threadId;
	});
	return { messageId, threadId };
}

async function thread(t: T, threadId: Id<'mailThreads'>): Promise<Doc<'mailThreads'>> {
	return (await t.run(async (ctx) => ctx.db.get(threadId)))!;
}

async function patchThread(t: T, threadId: Id<'mailThreads'>, patch: Partial<Doc<'mailThreads'>>) {
	await t.run(async (ctx) => {
		await ctx.db.patch(threadId, patch);
	});
}

async function listedThreadIds(t: T, mailboxId: Id<'mailboxes'>): Promise<string[]> {
	const res = await t.query(api.mail.mailbox.queries.listThreads, {
		mailboxId,
		folderRole: 'inbox',
	});
	return res.threads.map((row) => row._id);
}

describe('listThreads snooze copy', () => {
	it('decides from the copy on the thread once it is recorded', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);

		// The copy says snoozed, the message does not: the copy wins.
		await patchThread(t, threadId, { latestSnoozedUntil: Date.now() + HOUR });
		expect(await listedThreadIds(t, mailboxId)).toEqual([]);

		// And the other way round: a recorded "not snoozed" is not re-checked.
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() + HOUR });
		});
		await patchThread(t, threadId, { latestSnoozedUntil: null });
		expect(await listedThreadIds(t, mailboxId)).toEqual([threadId]);
	});

	it('falls back to the message on a thread with no copy yet', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeUndefined();
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() + HOUR });
		});
		expect(await listedThreadIds(t, mailboxId)).toEqual([]);
	});

	it('snoozeThread and unsnoozeMany keep the copy in step', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		const until = Date.now() + HOUR;

		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until });
		expect((await thread(t, threadId)).latestSnoozedUntil).toBe(until);
		expect(await listedThreadIds(t, mailboxId)).toEqual([]);

		await t.mutation(api.mail.snooze.unsnoozeMany, { messageIds: [messageId] });
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeNull();
		expect(await listedThreadIds(t, mailboxId)).toEqual([threadId]);
	});

	it('snooze, snoozeMany and the wake sweep keep the copy in step', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		const until = Date.now() + HOUR;

		await t.mutation(api.mail.snooze.snooze, { messageId, until });
		expect((await thread(t, threadId)).latestSnoozedUntil).toBe(until);

		await t.mutation(api.mail.snooze.snoozeMany, { messageIds: [messageId], until: until + 1 });
		expect((await thread(t, threadId)).latestSnoozedUntil).toBe(until + 1);

		// The wake time passes and the sweep returns the message.
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() - 1000 });
		});
		await t.mutation(internal.mail.snooze.internalSweep, {});
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeNull();
	});

	it('snoozing an older message of the thread leaves the copy alone', async () => {
		const { t, mailboxId } = await setup();
		const { threadId } = await seedConversation(t, mailboxId);
		await patchThread(t, threadId, { latestSnoozedUntil: null });
		// A second, older message in the same thread.
		const olderId = await t.run(async (ctx) => {
			const latest = (await ctx.db.get((await ctx.db.get(threadId))!.latestMessageId!))!;
			const { _id, _creationTime, ...rest } = latest;
			void _id;
			void _creationTime;
			return ctx.db.insert('mailMessages', {
				...rest,
				uid: 2,
				rfc822MessageId: '<older@example.com>',
				receivedAt: latest.receivedAt - HOUR,
			});
		});

		await t.mutation(api.mail.snooze.snooze, { messageId: olderId, until: Date.now() + HOUR });
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeNull();
		expect(await listedThreadIds(t, mailboxId)).toEqual([threadId]);
	});

	it('a new delivery into a snoozed thread brings it back', async () => {
		const { t, mailboxId } = await setup();
		const deliver = (messageId: string, receivedAt: number, inReplyTo?: string) =>
			t.run(async (ctx) => {
				const mailbox = (await ctx.db.get(mailboxId))!;
				const folder = (await ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
					.first())!;
				const rawStorageId = await ctx.storage.store(new Blob(['raw']));
				const id = await insertDeliveredMessage(ctx, {
					mailbox,
					folder,
					rawStorageId,
					rawSize: 3,
					from: 'someone@example.com',
					to: ['a@owlat.test'],
					cc: [],
					bcc: [],
					subject: inReplyTo ? 'Re: Quote' : 'Quote',
					textBodyInline: 'body',
					messageId,
					inReplyTo,
					receivedAt,
					attachments: [],
				});
				return (await ctx.db.get(id))!.threadId;
			});

		const threadId = await deliver('<quote@example.com>', Date.now() - HOUR);
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeNull();
		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until: Date.now() + HOUR });
		expect(await listedThreadIds(t, mailboxId)).toEqual([]);

		const replyThreadId = await deliver('<reply@example.com>', Date.now(), '<quote@example.com>');
		expect(replyThreadId).toBe(threadId);
		expect((await thread(t, threadId)).latestSnoozedUntil).toBeNull();
		expect(await listedThreadIds(t, mailboxId)).toEqual([threadId]);
	});

	it('rebuildThreadAggregates copies the latest message snooze', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		const until = Date.now() + HOUR;
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: until });
			await rebuildThreadAggregates(ctx, threadId);
		});
		expect((await thread(t, threadId)).latestSnoozedUntil).toBe(until);
	});
});

describe('listThreads rows', () => {
	it('carry the list fields and status markers, not drafts or summaries', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		await patchThread(t, threadId, {
			category: { label: 'person', source: 'heuristic', classifiedAt: 1 },
			summaryCache: { summary: 'LONG SUMMARY', messageCount: 1, generatedAt: 1 },
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				detectedAt: 1,
				draftSlot: { draft: 'DRAFT BODY', confidence: 0.8, generatedAt: 1 },
			},
			followUp: { messageId, remindAt: 5, armedAt: 1 },
		});

		const res = await t.query(api.mail.mailbox.queries.listThreads, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(res.threads).toEqual([
			{
				_id: threadId,
				latestMessageId: messageId,
				latestFromAddress: 'someone@example.com',
				latestSubject: 'hello',
				latestSnippet: 'hello',
				lastMessageAt: expect.any(Number),
				messageCount: 1,
				unreadCount: 1,
				hasFlagged: false,
				hasAttachments: false,
				category: { label: 'person' },
				needsReply: { draftSlot: true },
				followUp: {},
			},
		]);
		expect(JSON.stringify(res)).not.toContain('DRAFT BODY');
		expect(JSON.stringify(res)).not.toContain('LONG SUMMARY');
	});
});

describe('Reply Queue trigger copy', () => {
	async function flagged(t: T, mailboxId: Id<'mailboxes'>) {
		const convo = await seedConversation(t, mailboxId);
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId: convo.threadId,
			expectedLatestMessageId: convo.messageId,
			needsReply: { messageId: convo.messageId, source: 'heuristic', urgency: 'normal' },
		});
		return convo;
	}

	it('applyResult copies the trigger sender, subject and time onto the flag', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await flagged(t, mailboxId);
		const message = (await t.run(async (ctx) => ctx.db.get(messageId)))!;
		expect((await thread(t, threadId)).needsReply?.trigger).toEqual({
			fromAddress: 'someone@example.com',
			fromName: 'Ann',
			subject: 'hello',
			receivedAt: message.receivedAt,
		});
	});

	it('listQueue serves the row from the copy when the trigger is the newest message', async () => {
		const { t, mailboxId } = await setup();
		const { threadId } = await flagged(t, mailboxId);
		const flag = (await thread(t, threadId)).needsReply!;
		await patchThread(t, threadId, {
			needsReply: { ...flag, trigger: { ...flag.trigger!, subject: 'FROM THE COPY' } },
		});

		const { items } = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(items.map((i) => i.subject)).toEqual(['FROM THE COPY']);

		// Snoozed per the thread copy: hidden without looking at the message.
		await patchThread(t, threadId, { latestSnoozedUntil: Date.now() + HOUR });
		expect((await t.query(api.mail.needsReply.listQueue, { mailboxId })).items).toEqual([]);
	});

	it('listQueue loads the message when the trigger is no longer the newest', async () => {
		const { t, mailboxId } = await setup();
		const { threadId, messageId } = await flagged(t, mailboxId);
		const flag = (await thread(t, threadId)).needsReply!;
		const other = await seedMessage(t, mailboxId, { subject: 'other' });
		await patchThread(t, threadId, {
			latestMessageId: other,
			needsReply: { ...flag, trigger: { ...flag.trigger!, subject: 'STALE COPY' } },
		});

		const { items } = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(items.map((i) => i.subject)).toEqual(['hello']);

		await t.run(async (ctx) => {
			await ctx.db.delete(messageId);
		});
		expect((await t.query(api.mail.needsReply.listQueue, { mailboxId })).items).toEqual([]);
	});

	it('rows say whether a draft exists; getDraftSlot returns it to the owner only', async () => {
		const { t, mailboxId } = await setup();
		const { threadId } = await flagged(t, mailboxId);
		const flag = (await thread(t, threadId)).needsReply!;
		const draftSlot = { draft: 'DRAFT BODY', confidence: 0.7, generatedAt: 1 };
		await patchThread(t, threadId, { needsReply: { ...flag, draftSlot } });

		const { items } = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(items).toHaveLength(1);
		expect(items[0]!.hasDraftSlot).toBe(true);
		expect(JSON.stringify(items)).not.toContain('DRAFT BODY');

		expect(await t.query(api.mail.needsReply.getDraftSlot, { threadId })).toEqual(draftSlot);

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce({
			userId: 'user-B',
			role: 'editor',
			activeOrganizationId: 'org-1',
		});
		expect(await t.query(api.mail.needsReply.getDraftSlot, { threadId })).toBeNull();

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce(null);
		expect(await t.query(api.mail.needsReply.getDraftSlot, { threadId })).toBeNull();
	});

	it('getDraftSlot leaves out the alternatives a legacy slot still stores (#1200)', async () => {
		const { t, mailboxId } = await setup();
		const { threadId } = await flagged(t, mailboxId);
		const flag = (await thread(t, threadId)).needsReply!;
		const shown = { draft: 'DRAFT BODY', confidence: 0.7, generatedAt: 1 };
		// Written before #1200; a web build from then counts these as "3 options".
		const draftSlot = { ...shown, options: ['DRAFT BODY', 'ALT ONE', 'ALT TWO'] };
		await patchThread(t, threadId, { needsReply: { ...flag, draftSlot } });

		expect(await t.query(api.mail.needsReply.getDraftSlot, { threadId })).toEqual(shown);
	});
});

describe('migration 0047', () => {
	it('fills both copies on old rows and is safe to re-run', async () => {
		const { t, mailboxId } = await setup();
		const { messageId, threadId } = await seedConversation(t, mailboxId);
		const until = Date.now() + HOUR;
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: until });
		});
		await patchThread(t, threadId, {
			needsReply: { messageId, source: 'heuristic', urgency: 'normal', detectedAt: 1 },
		});
		// A second thread with no latest message pointer at all.
		const bare = await seedMessage(t, mailboxId, { subject: 'bare' });
		const bareThreadId = (await t.run(async (ctx) => ctx.db.get(bare)))!.threadId;

		const first = await t.mutation(
			internal.migrations['0047_denormalize_thread_rows'].backfillPage,
			{ cursor: null }
		);
		expect(first).toMatchObject({ snooze: 2, triggers: 1, isDone: true });

		const row = await thread(t, threadId);
		expect(row.latestSnoozedUntil).toBe(until);
		expect(row.needsReply?.trigger?.subject).toBe('hello');
		expect((await thread(t, bareThreadId)).latestSnoozedUntil).toBeNull();

		const second = await t.mutation(
			internal.migrations['0047_denormalize_thread_rows'].backfillPage,
			{ cursor: null }
		);
		expect(second).toMatchObject({ snooze: 0, triggers: 0 });
	});
});
