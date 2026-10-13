/**
 * A response completes the reply it answers (#1346): the saved composer draft
 * and the generated reply for the answered mail go, whether the response was
 * sent through Owlat (draftLifecycle → sent) or detected through sync/APPEND
 * (`settleOwnerReply`, via the delivery pipeline's post-insert tail). Nothing
 * newer than the response is touched, a cancelled send keeps its draft, and a
 * late AI generation cannot write the obsolete reply back.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { settleOwnerReply } from '../answeredReply';
import { runPostInsertInboundEffects } from '../deliveryPipeline/afterInsert';

const OWNER = 'me@owlat.test';
const SENDER = 'sam@acme.test';
const T0 = 1_700_000_000_000;

type T = TestConvex<typeof schema>;

interface Conversation {
	mailboxId: Id<'mailboxes'>;
	threadId: Id<'mailThreads'>;
	/** The inbound message that asked for a reply, received at T0. */
	askId: Id<'mailMessages'>;
}

async function seedConversation(t: T): Promise<Conversation> {
	const mailboxId = await seedMailbox(t, { address: OWNER });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	await seedFolder(t, mailboxId, 'drafts');
	const askId = await seedMessage(t, mailboxId, {
		subject: 'Can you send the report?',
		fromAddress: SENDER,
		receivedAt: T0,
	});
	const threadId = await t.run(async (ctx) => {
		const ask = (await ctx.db.get(askId))!;
		await ctx.db.patch(ask.threadId, { latestMessageId: askId });
		return ask.threadId;
	});
	return { mailboxId, threadId, askId };
}

/** Add a message to the conversation, filed in `role`, and make it the latest. */
async function addMessage(
	t: T,
	c: Conversation,
	opts: { from: string; at: number; role: 'inbox' | 'sent' | 'drafts' }
): Promise<Id<'mailMessages'>> {
	return await t.run(async (ctx) => {
		const folder = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', c.mailboxId).eq('role', opts.role))
			.first())!;
		const ask = (await ctx.db.get(c.askId))!;
		const { _id, _creationTime, ...base } = ask;
		const id = await ctx.db.insert('mailMessages', {
			...base,
			folderId: folder._id,
			uid: Math.floor(opts.at / 1000),
			rfc822MessageId: `<${opts.at}@example.com>`,
			fromAddress: opts.from,
			toAddresses: [opts.from === OWNER ? SENDER : OWNER],
			receivedAt: opts.at,
			internalDate: opts.at,
		});
		const thread = (await ctx.db.get(c.threadId))!;
		if (opts.at >= thread.lastMessageAt) {
			await ctx.db.patch(c.threadId, { latestMessageId: id, lastMessageAt: opts.at });
		}
		return id;
	});
}

/** The thread asks for a reply to `messageId` and has a generated draft for it. */
async function flagWithSlot(t: T, c: Conversation, messageId: Id<'mailMessages'>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.patch(c.threadId, {
			needsReply: {
				messageId,
				detectedAt: T0,
				source: 'llm' as const,
				urgency: 'normal' as const,
				draftSlot: { draft: 'Here is the report.', confidence: 0.9, generatedAt: T0 },
			},
		});
	});
}

async function seedDraft(
	t: T,
	c: Conversation,
	opts: {
		inReplyTo: Id<'mailMessages'>;
		editedAt: number;
		state?: Doc<'mailDrafts'>['state'];
	}
): Promise<Id<'mailDrafts'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId: c.mailboxId,
			threadId: c.threadId,
			inReplyToMessageId: opts.inReplyTo,
			toAddresses: [SENDER],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: OWNER,
			subject: 'Re: Can you send the report?',
			bodyHtml: '<p>Draft</p>',
			attachments: [],
			state: opts.state ?? 'draft',
			...(opts.state === 'pending_send' ? { undoToken: 'undo-1' } : {}),
			lastEditedAt: opts.editedAt,
			createdAt: opts.editedAt,
		})
	);
}

async function draftExists(t: T, draftId: Id<'mailDrafts'>): Promise<boolean> {
	return await t.run(async (ctx) => (await ctx.db.get(draftId)) !== null);
}

async function thread(t: T, c: Conversation): Promise<Doc<'mailThreads'>> {
	return await t.run(async (ctx) => (await ctx.db.get(c.threadId))!);
}

/** Owlat's send of `draftId` reaches `→ sent` (the dispatch action's transition). */
async function sendThroughOwlat(t: T, draftId: Id<'mailDrafts'>) {
	const rawStorageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw-out'])));
	return await t.mutation(internal.mail.draftLifecycle.transition, {
		draftId,
		input: {
			to: 'sent',
			at: Date.now(),
			context: {
				rawStorageId,
				rawSize: 7,
				rfc822MessageId: 'reply@owlat.test',
				references: [],
				bodyHtml: '<p>Sent</p>',
				bodyText: 'Sent',
				attachmentsMeta: [],
			},
		},
	});
}

/** A late draft-on-arrival run for `messageId` completes. */
async function lateGeneration(t: T, c: Conversation, messageId: Id<'mailMessages'>) {
	await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
		threadId: c.threadId,
		triggerMessageId: messageId,
		draft: 'Here is the report, again.',
		confidence: 0.9,
	});
}

/** A message synced in from the provider runs the delivery pipeline's tail. */
async function syncIn(t: T, messageId: Id<'mailMessages'>): Promise<void> {
	await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const folder = (await ctx.db.get(message.folderId))!;
		await runPostInsertInboundEffects(ctx, { messageId, folder, origin: 'sync' });
	});
}

describe('a reply sent through Owlat', () => {
	it('removes the saved and generated drafts for the answered mail, not one for newer mail', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const newerId = await addMessage(t, c, { from: SENDER, at: T0 + 5_000, role: 'inbox' });
		await flagWithSlot(t, c, c.askId);
		const sending = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			state: 'pending_send',
		});
		const duplicate = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000 });
		const forNewer = await seedDraft(t, c, { inReplyTo: newerId, editedAt: T0 + 6_000 });

		expect((await sendThroughOwlat(t, sending)).ok).toBe(true);

		expect(await draftExists(t, sending)).toBe(false);
		expect(await draftExists(t, duplicate)).toBe(false);
		expect(await draftExists(t, forNewer)).toBe(true);
		expect((await thread(t, c)).needsReply).toBeUndefined();

		// A generation started before the send cannot bring the reply back.
		await lateGeneration(t, c, c.askId);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it('keeps every draft when the send is cancelled in the undo window', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const sending = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			state: 'pending_send',
		});
		const other = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000 });

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId: sending,
			input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
		});
		expect(outcome.ok).toBe(true);

		expect(await draftExists(t, sending)).toBe(true);
		expect(await draftExists(t, other)).toBe(true);
		expect((await thread(t, c)).needsReply?.draftSlot?.draft).toBe('Here is the report.');
	});
});

describe('a reply sent from an external client', () => {
	it('removes the drafts once sync detects it, and repeated syncs or a late generation change nothing', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const saved = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const scheduled = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			state: 'scheduled',
		});
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await syncIn(t, sentId);

		expect(await draftExists(t, saved)).toBe(false);
		expect(await draftExists(t, scheduled)).toBe(true); // a send the owner chose, not a draft
		expect((await thread(t, c)).needsReply).toBeUndefined();

		await syncIn(t, sentId);
		await lateGeneration(t, c, c.askId);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it('settles the same way when a desktop client APPENDs it', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const saved = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await t.run(async (ctx) => settleOwnerReply(ctx, sentId));

		expect(await draftExists(t, saved)).toBe(false);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it('keeps a draft edited after the reply was sent', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });
		const followUp = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 20_000 });

		await syncIn(t, sentId);

		expect(await draftExists(t, followUp)).toBe(true);
	});

	it('does not treat our own draft synced from the Drafts folder as a reply', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const saved = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const providerDraft = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'drafts' });

		await syncIn(t, providerDraft);

		expect(await draftExists(t, saved)).toBe(true);
		expect((await thread(t, c)).needsReply?.draftSlot).toBeDefined();
	});

	it('a delayed sync of an older reply leaves the draft for a newer inbound mail', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const answered = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const newerId = await addMessage(t, c, { from: SENDER, at: T0 + 20_000, role: 'inbox' });
		await flagWithSlot(t, c, newerId);
		const forNewer = await seedDraft(t, c, { inReplyTo: newerId, editedAt: T0 + 21_000 });
		// Sent at T0+10s, before the newer mail, but only synced now.
		const olderSentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await syncIn(t, olderSentId);

		expect(await draftExists(t, answered)).toBe(false);
		expect(await draftExists(t, forNewer)).toBe(true);
		const flag = (await thread(t, c)).needsReply;
		expect(flag?.messageId).toBe(newerId);
		expect(flag?.draftSlot?.draft).toBe('Here is the report.');
	});
});

describe('a new inbound mail after the response', () => {
	it('reopens the draft flow for that mail with a fresh draft', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const saved = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });
		await syncIn(t, sentId);

		const nextId = await addMessage(t, c, { from: SENDER, at: T0 + 30_000, role: 'inbox' });
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId: c.threadId,
			expectedLatestMessageId: nextId,
			needsReply: { messageId: nextId, source: 'llm', urgency: 'normal' },
		});
		// Nothing of the old reply came back with the flag.
		expect((await thread(t, c)).needsReply?.draftSlot).toBeUndefined();
		expect(await draftExists(t, saved)).toBe(false);

		await lateGeneration(t, c, c.askId); // the old trigger's run: stale
		expect((await thread(t, c)).needsReply?.draftSlot).toBeUndefined();

		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId: c.threadId,
			triggerMessageId: nextId,
			draft: 'Thanks, noted.',
			confidence: 0.8,
		});
		const flag = (await thread(t, c)).needsReply;
		expect(flag?.messageId).toBe(nextId);
		expect(flag?.draftSlot?.draft).toBe('Thanks, noted.');
	});
});
