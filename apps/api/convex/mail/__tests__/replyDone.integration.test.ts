/**
 * "Send and mark done" (mail/replyDone.ts): the choice rides on one send of a
 * reply, survives the undo window only as long as the send does, and archives
 * the answered conversation once the reply is sent: its Inbox mail up to the
 * moment the sender chose, never newer mail, never another mailbox's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import betterAuthSchema from '../../betterAuth/schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { doneOnSendCutoff } from '../draftSend';
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

beforeEach(() => {
	session.userId = 'user-A';
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
		// The move's bookkeeping: the Archive folder counts what it took in.
		const archive = await t.run((ctx) => ctx.db.get(conv.archiveId));
		expect(archive?.totalCount).toBe(2);
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
