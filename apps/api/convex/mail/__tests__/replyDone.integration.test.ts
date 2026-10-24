/**
 * "Send and mark done" (mail/replyDone.ts): the choice rides on one send of a
 * reply, survives the undo window only as long as the send does, and archives
 * the answered conversation once the reply is sent: its Inbox mail up to the
 * moment the sender chose, never newer mail, never another mailbox's. The
 * conversation's Reply Queue state goes only when its Inbox is left empty, and
 * a long conversation never has every message re-read per batch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import betterAuthSchema from '../../betterAuth/schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { doneOnSendCutoff } from '../draftSend';
import { REPLY_DONE_BATCH } from '../replyDone';
import { rebuildThreadAggregates } from '../threadAggregates';
import { liveMailTest, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

// Passed through, counted: the whole-thread re-read the batched archive avoids.
vi.mock('../threadAggregates', async (importOriginal) => {
	const actual = await importOriginal<{
		rebuildThreadAggregates: typeof rebuildThreadAggregates;
	}>();
	return { ...actual, rebuildThreadAggregates: vi.fn(actual.rebuildThreadAggregates) };
});

beforeEach(() => {
	session.userId = 'user-A';
	vi.mocked(rebuildThreadAggregates).mockClear();
});
afterEach(() => {
	vi.useRealTimers();
});

type T = ReturnType<typeof liveMailTest>;

// The access re-check asks the auth component whether a non-member is an org
// admin; with no member row there, the answer is no.
const betterAuthModules = import.meta.glob('../../betterAuth/**/*.*s');
function convexTest(): T {
	const t = liveMailTest();
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

async function seedConversation(t: T) {
	const mailboxId = await seedMailbox(t);
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	const archiveId = await seedFolder(t, mailboxId, 'archive');
	await seedFolder(t, mailboxId, 'sent');
	const first = await seedMessage(t, mailboxId, { subject: 'invoice' });
	const threadId = await t.run(async (ctx) => (await ctx.db.get(first))!.threadId);
	return { mailboxId, inboxId, archiveId, threadId, first };
}

/** Another Inbox message in the same conversation, arriving now. */
async function arriveInThread(t: T, mailboxId: Id<'mailboxes'>, threadId: Id<'mailThreads'>) {
	const id = await seedMessage(t, mailboxId, { subject: 'invoice' });
	await t.run((ctx) => ctx.db.patch(id, { threadId }));
	return id;
}

async function seedReplyDraft(
	t: T,
	conv: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'>; first: Id<'mailMessages'> },
	extra: { doneOnSendAt?: number; state?: 'draft' | 'pending_send'; isForward?: boolean } = {}
) {
	return t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId: conv.mailboxId,
			...(extra.isForward ? {} : { inReplyToMessageId: conv.first, threadId: conv.threadId }),
			toAddresses: ['someone@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: 'Re: invoice',
			bodyHtml: '<p>Paid.</p>',
			attachments: [],
			state: extra.state ?? 'draft',
			sentByUserId: 'user-A',
			...(extra.doneOnSendAt !== undefined ? { doneOnSendAt: extra.doneOnSendAt } : {}),
			...(extra.state === 'pending_send' ? { undoToken: 'tok-done' } : {}),
			lastEditedAt: Date.now(),
			createdAt: Date.now(),
		})
	);
}

const folderOf = (t: T, id: Id<'mailMessages'>) =>
	t.run(async (ctx) => (await ctx.db.get(id))!.folderId);

const threadOf = (t: T, id: Id<'mailThreads'>) => t.run((ctx) => ctx.db.get(id));

/** The thread row as a full re-derivation from its messages leaves it. */
async function rebuiltThread(t: T, id: Id<'mailThreads'>) {
	await t.run((ctx) => rebuildThreadAggregates(ctx, id));
	return threadOf(t, id);
}

/** What the thread row says about its messages (not when it was written). */
function aggregatesOf(thread: Awaited<ReturnType<typeof threadOf>>) {
	const { _creationTime, updatedAt, folderRoles, ...rest } = thread!;
	return { ...rest, folderRoles: [...folderRoles].sort() };
}

const archiveAnswered = (
	t: T,
	conv: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'>; first: Id<'mailMessages'> },
	cutoffAt: number
) =>
	t.mutation(internal.mail.replyDone.archiveAnswered, {
		mailboxId: conv.mailboxId,
		threadId: conv.threadId,
		repliedToMessageId: conv.first,
		userId: 'user-A',
		cutoffAt,
	});

describe('doneOnSendCutoff', () => {
	const reply = {
		inReplyToMessageId: 'm' as Id<'mailMessages'>,
		threadId: 't' as Id<'mailThreads'>,
	};

	it('is set only for a reply sent with done', () => {
		expect(doneOnSendCutoff(reply, { afterSend: 'done' }, 1_000)).toBe(1_000);
		expect(doneOnSendCutoff(reply, { afterSend: 'keep' }, 1_000)).toBeUndefined();
		expect(doneOnSendCutoff(reply, {}, 1_000)).toBeUndefined();
		expect(doneOnSendCutoff({}, { afterSend: 'done' }, 1_000)).toBeUndefined();
	});

	it('keeps an earlier choice and never reaches past the server clock', () => {
		expect(doneOnSendCutoff(reply, { afterSend: 'done', afterSendChosenAt: 400 }, 1_000)).toBe(400);
		expect(doneOnSendCutoff(reply, { afterSend: 'done', afterSendChosenAt: 9_000 }, 1_000)).toBe(
			1_000
		);
	});
});

describe('drafts.send carries the after-send choice', () => {
	it('stamps done on the reply, and a later keep send clears it', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const draftId = await seedReplyDraft(t, conv);

		const sent = await t.mutation(api.mail.drafts.send, { draftId, afterSend: 'done' });
		const pending = await t.run((ctx) => ctx.db.get(draftId));
		expect(pending?.state).toBe('pending_send');
		expect(pending?.doneOnSendAt).toEqual(expect.any(Number));

		// Undo: the choice belonged to that send only.
		await t.mutation(api.mail.drafts.cancelPendingSend, { undoToken: sent.undoToken });
		expect((await t.run((ctx) => ctx.db.get(draftId)))?.doneOnSendAt).toBeUndefined();

		await t.mutation(api.mail.drafts.send, { draftId, afterSend: 'keep' });
		expect((await t.run((ctx) => ctx.db.get(draftId)))?.doneOnSendAt).toBeUndefined();
	});

	it('never stamps a forward or a new message', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const draftId = await seedReplyDraft(t, conv, { isForward: true });
		await t.mutation(api.mail.drafts.send, { draftId, afterSend: 'done' });
		expect((await t.run((ctx) => ctx.db.get(draftId)))?.doneOnSendAt).toBeUndefined();
	});
});

describe('the sent transition schedules the archive', () => {
	const sentInput = (rawStorageId: Id<'_storage'>) => ({
		to: 'sent' as const,
		at: Date.now(),
		context: {
			rawStorageId,
			rawSize: 10,
			rfc822MessageId: 'reply@example.com',
			references: [],
			bodyHtml: '<p>Paid.</p>',
			bodyText: 'Paid.',
			attachmentsMeta: [],
		},
	});
	const scheduledReplyDone = (t: T) =>
		t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
				job.name.includes('replyDone')
			)
		);

	it('for a reply sent with done, with the answered conversation and the cutoff', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const draftId = await seedReplyDraft(t, conv, { state: 'pending_send', doneOnSendAt: 1234 });
		const raw = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: sentInput(raw),
		});
		expect(outcome.ok).toBe(true);
		const jobs = await scheduledReplyDone(t);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.args[0]).toEqual({
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-A',
			cutoffAt: 1234,
		});
	});

	it('not for a reply that keeps its conversation', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const draftId = await seedReplyDraft(t, conv, { state: 'pending_send' });
		const raw = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
		await t.mutation(internal.mail.draftLifecycle.transition, { draftId, input: sentInput(raw) });
		expect(await scheduledReplyDone(t)).toHaveLength(0);
	});
});

describe('replyDone.archiveAnswered', () => {
	it('archives the Inbox mail up to the cutoff, keeps newer mail and the Sent copy', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		// The reply's own Sent copy predates the cutoff: only the Inbox is walked.
		const sentCopy = await seedMessage(t, conv.mailboxId, { subject: 'Re: invoice', role: 'sent' });
		await t.run((ctx) => ctx.db.patch(sentCopy, { threadId: conv.threadId }));
		const sentId = await folderOf(t, sentCopy);
		const older = await arriveInThread(t, conv.mailboxId, conv.threadId);
		const cutoffAt = await t.run(async (ctx) => (await ctx.db.get(older))!._creationTime);
		const newer = await arriveInThread(t, conv.mailboxId, conv.threadId);

		const result = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-A',
			cutoffAt,
		});

		expect(result).toEqual({ archived: 2 });
		expect(await folderOf(t, conv.first)).toBe(conv.archiveId);
		expect(await folderOf(t, older)).toBe(conv.archiveId);
		expect(await folderOf(t, newer)).toBe(conv.inboxId);
		expect(await folderOf(t, sentCopy)).toBe(sentId);
		// The move's bookkeeping: the Archive folder counts what it took in.
		const archive = await t.run((ctx) => ctx.db.get(conv.archiveId));
		expect(archive?.totalCount).toBe(2);
	});

	describe("the conversation's Reply Queue state", () => {
		const needsReplyOf = (messageId: Id<'mailMessages'>, at: number) => ({
			messageId,
			source: 'heuristic' as const,
			urgency: 'normal' as const,
			detectedAt: at,
		});

		it('stays with newer Inbox mail, classified or still waiting for its verdict', async () => {
			for (const kind of ['settled', 'pending'] as const) {
				const t = convexTest();
				const conv = await seedConversation(t);
				const cutoffAt = await t.run(async (ctx) => (await ctx.db.get(conv.first))!._creationTime);
				const newer = await arriveInThread(t, conv.mailboxId, conv.threadId);
				const verdict = needsReplyOf(newer, cutoffAt + 100);
				await t.run((ctx) =>
					ctx.db.patch(
						conv.threadId,
						kind === 'settled' ? { needsReply: verdict } : { needsReplyPendingAt: cutoffAt + 100 }
					)
				);

				expect(await archiveAnswered(t, conv, cutoffAt)).toEqual({ archived: 1 });

				expect(await folderOf(t, newer)).toBe(conv.inboxId);
				const thread = await threadOf(t, conv.threadId);
				if (kind === 'settled') expect(thread?.needsReply).toEqual(verdict);
				else expect(thread?.needsReplyPendingAt).toBe(cutoffAt + 100);
			}
		});

		it('goes with the conversation once its Inbox is empty', async () => {
			const t = convexTest();
			const conv = await seedConversation(t);
			const older = await arriveInThread(t, conv.mailboxId, conv.threadId);
			await t.run((ctx) =>
				ctx.db.patch(conv.threadId, { needsReply: needsReplyOf(older, Date.now()) })
			);

			const cutoffAt = await t.run(async (ctx) => (await ctx.db.get(older))!._creationTime);
			expect(await archiveAnswered(t, conv, cutoffAt)).toEqual({ archived: 2 });

			expect((await threadOf(t, conv.threadId))?.needsReply).toBeUndefined();
		});
	});

	it('updates the thread row as a full re-derivation would, without one', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const older = await arriveInThread(t, conv.mailboxId, conv.threadId);
		const cutoffAt = await t.run(async (ctx) => (await ctx.db.get(older))!._creationTime);
		await rebuiltThread(t, conv.threadId);
		vi.mocked(rebuildThreadAggregates).mockClear();

		// Everything moves: the Inbox role goes, the Archive role comes.
		await archiveAnswered(t, conv, cutoffAt);
		expect(rebuildThreadAggregates).not.toHaveBeenCalled();
		const after = await threadOf(t, conv.threadId);
		expect(after?.folderRoles).toEqual(['archive']);
		expect(aggregatesOf(after)).toEqual(aggregatesOf(await rebuiltThread(t, conv.threadId)));
	});

	it('always archives the message replied to, even behind a slow clock', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const result = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-A',
			cutoffAt: 0,
		});
		expect(result).toEqual({ archived: 1 });
		expect(await folderOf(t, conv.first)).toBe(conv.archiveId);
	});

	it('archives a conversation longer than one run in follow-up runs, reply target included', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		// More eligible Inbox mail than one run moves. The reply target has the
		// newest received time, so the walk reaches it last; a message that
		// arrived after the cutoff sorts first and must not stall the walk.
		const { cutoffAt, newer } = await t.run(async (ctx) => {
			const { _id, _creationTime, ...fields } = (await ctx.db.get(conv.first))!;
			let last = _id;
			for (let i = 0; i < REPLY_DONE_BATCH; i++) {
				last = await ctx.db.insert('mailMessages', {
					...fields,
					uid: 2 + i,
					receivedAt: fields.receivedAt - 1000 - i,
				});
			}
			const cutoff = (await ctx.db.get(last))!._creationTime;
			const late = await ctx.db.insert('mailMessages', {
				...fields,
				uid: 2 + REPLY_DONE_BATCH,
				receivedAt: fields.receivedAt - 1_000_000,
			});
			await ctx.db.patch(conv.inboxId, { totalCount: REPLY_DONE_BATCH + 2 });
			return { cutoffAt: cutoff, newer: late };
		});
		await rebuiltThread(t, conv.threadId);
		vi.mocked(rebuildThreadAggregates).mockClear();
		vi.useFakeTimers();

		const first = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-A',
			cutoffAt,
		});
		// The first run moves the reply target with its batch and leaves the rest
		// to the run it scheduled.
		expect(first.archived).toBeLessThanOrEqual(REPLY_DONE_BATCH + 1);
		expect(await folderOf(t, conv.first)).toBe(conv.archiveId);
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const inInbox = await t.run((ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_thread_folder_received', (q) =>
					q.eq('threadId', conv.threadId).eq('folderId', conv.inboxId)
				)
				.collect()
		);
		expect(inInbox.map((m) => m._id)).toEqual([newer]);
		const archive = await t.run((ctx) => ctx.db.get(conv.archiveId));
		expect(archive?.totalCount).toBe(REPLY_DONE_BATCH + 1);
		// No run re-read the whole conversation, and the thread row still says
		// what a re-derivation says: mail in both the Inbox and the Archive.
		expect(rebuildThreadAggregates).not.toHaveBeenCalled();
		const after = await threadOf(t, conv.threadId);
		expect([...after!.folderRoles].sort()).toEqual(['archive', 'inbox']);
		expect(aggregatesOf(after)).toEqual(aggregatesOf(await rebuiltThread(t, conv.threadId)));
	});

	it('stops a follow-up run once the sender lost access', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const older = await arriveInThread(t, conv.mailboxId, conv.threadId);
		const result = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-B',
			cutoffAt: Date.now(),
			cursor: 'from-an-earlier-run',
		});
		expect(result).toEqual({ archived: 0 });
		expect(await folderOf(t, older)).toBe(conv.inboxId);
	});

	it('does nothing once the sender lost access to the mailbox', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const result = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: conv.mailboxId,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-B',
			cutoffAt: Date.now(),
		});
		expect(result).toEqual({ archived: 0 });
		expect(await folderOf(t, conv.first)).toBe(conv.inboxId);
	});

	it('never touches a thread of another mailbox', async () => {
		const t = convexTest();
		const conv = await seedConversation(t);
		const otherMailbox = await seedMailbox(t, { address: 'b@owlat.test' });
		await seedFolder(t, otherMailbox, 'inbox');
		await seedFolder(t, otherMailbox, 'archive');
		const result = await t.mutation(internal.mail.replyDone.archiveAnswered, {
			mailboxId: otherMailbox,
			threadId: conv.threadId,
			repliedToMessageId: conv.first,
			userId: 'user-A',
			cutoffAt: Date.now(),
		});
		expect(result).toEqual({ archived: 0 });
		expect(await folderOf(t, conv.first)).toBe(conv.inboxId);
	});
});
