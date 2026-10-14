/**
 * A response completes the reply it answers (#1346): the generated reply and
 * the saved AI draft for the answered mail go, whether the response was sent
 * through Owlat (once its transport accepted it) or detected through
 * sync/APPEND (`settleOwnerReply`, via the delivery pipeline's post-insert
 * tail). A draft a person wrote or edited always stays, nothing newer than the
 * response is touched, a cancelled or failed send keeps every draft, and a
 * late AI generation cannot write the obsolete reply back.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { aiTextToHtml } from '@owlat/shared/answerMode';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { settleOwnerReply } from '../answeredReply';
import { runPostInsertInboundEffects } from '../deliveryPipeline/afterInsert';

const OWNER = 'me@owlat.test';
const SENDER = 'sam@acme.test';
const T0 = 1_700_000_000_000;
const AI_TEXT = "Hi Sam,\n\nHere's the report.\n\nBest";
/** The seeded tail an AI draft never touches: the quoted original. */
const QUOTE = '<br><br><div class="gmail_quote">On Monday Sam wrote: send the report?</div>';

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

/**
 * A saved reply draft. `ai` makes it an AI draft (baseline recorded, the AI's
 * text in the body above the quote); `typed` is what a person changed the
 * body's written part to. Without `ai` it is a draft a person wrote.
 */
async function seedDraft(
	t: T,
	c: Conversation,
	opts: {
		inReplyTo: Id<'mailMessages'>;
		editedAt: number;
		ai?: boolean;
		typed?: string;
		state?: Doc<'mailDrafts'>['state'];
	}
): Promise<Id<'mailDrafts'>> {
	const written = opts.typed ?? (opts.ai ? AI_TEXT : 'Thanks, I will look at it.');
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
			bodyHtml: `${aiTextToHtml(written)}${QUOTE}`,
			...(opts.ai ? { aiDraftBaseline: { text: AI_TEXT, capturedAt: opts.editedAt } } : {}),
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
async function sendThroughOwlat(t: T, draftId: Id<'mailDrafts'>): Promise<Id<'mailMessages'>> {
	const rawStorageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw-out'])));
	const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
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
	if (!outcome.ok || !outcome.messageId) throw new Error('send did not reach → sent');
	return outcome.messageId;
}

/** The transport's verdict on the sent reply's only recipient. */
async function transport(
	t: T,
	mailMessageId: Id<'mailMessages'>,
	verdict: 'sent' | 'bounced' | 'failed'
): Promise<void> {
	const at = Date.now();
	await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
		mailMessageId,
		recipientIdx: 0,
		input:
			verdict === 'sent'
				? { to: 'sent', at }
				: verdict === 'bounced'
					? { to: 'bounced', at, bounceMessage: 'MTA POST 550: refused' }
					: {
							to: 'failed',
							at,
							errorMessage: 'connect ECONNREFUSED',
							errorCode: 'MTA_POST_NETWORK',
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
async function syncIn(
	t: T,
	messageId: Id<'mailMessages'>,
	antiLoopHeaders?: Record<string, string>
): Promise<void> {
	await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const folder = (await ctx.db.get(message.folderId))!;
		await runPostInsertInboundEffects(ctx, {
			messageId,
			folder,
			origin: 'sync',
			...(antiLoopHeaders ? { antiLoopHeaders } : {}),
		});
	});
}

describe('a reply sent through Owlat', () => {
	it('removes the untouched AI drafts once the transport accepts it, and keeps a person’s', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const newerId = await addMessage(t, c, { from: SENDER, at: T0 + 5_000, role: 'inbox' });
		await flagWithSlot(t, c, c.askId);
		const sending = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			state: 'pending_send',
		});
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000, ai: true });
		const written = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000 });
		const edited = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 2_000,
			ai: true,
			typed: `${AI_TEXT} PS: numbers on page 3.`,
		});
		const forNewer = await seedDraft(t, c, { inReplyTo: newerId, editedAt: T0 + 6_000, ai: true });

		const sentId = await sendThroughOwlat(t, sending);
		expect(await draftExists(t, sending)).toBe(false);
		// Queued, not yet accepted: nothing else has gone.
		expect(await draftExists(t, aiDraft)).toBe(true);
		expect((await thread(t, c)).needsReply).toBeUndefined();

		await transport(t, sentId, 'sent');

		expect(await draftExists(t, aiDraft)).toBe(false);
		expect(await draftExists(t, written)).toBe(true);
		expect(await draftExists(t, edited)).toBe(true);
		expect(await draftExists(t, forNewer)).toBe(true);

		// A generation started before the send cannot bring the reply back.
		await lateGeneration(t, c, c.askId);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it.each(['bounced', 'failed'] as const)(
		'keeps the other drafts when the transport refuses it after queuing (%s)',
		async (verdict) => {
			const t = convexTest(schema, modules);
			const c = await seedConversation(t);
			const sending = await seedDraft(t, c, {
				inReplyTo: c.askId,
				editedAt: T0 + 1_000,
				state: 'pending_send',
			});
			const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000, ai: true });

			const sentId = await sendThroughOwlat(t, sending);
			await transport(t, sentId, verdict);

			expect(await draftExists(t, aiDraft)).toBe(true);
		}
	);

	it('keeps every draft when the send is cancelled in the undo window', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const sending = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			state: 'pending_send',
		});
		const other = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 2_000, ai: true });

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
	it('removes the AI draft once sync detects it, and repeated syncs or a late generation change nothing', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
		const scheduled = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			ai: true,
			state: 'scheduled',
		});
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await syncIn(t, sentId);

		expect(await draftExists(t, aiDraft)).toBe(false);
		expect(await draftExists(t, scheduled)).toBe(true); // a send the owner chose, not a draft
		expect((await thread(t, c)).needsReply).toBeUndefined();

		await syncIn(t, sentId);
		await lateGeneration(t, c, c.askId);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it('keeps a draft a person wrote, and an AI draft a person edited', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const written = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000 });
		const edited = await seedDraft(t, c, {
			inReplyTo: c.askId,
			editedAt: T0 + 1_000,
			ai: true,
			typed: `Quick note first. ${AI_TEXT}`,
		});
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await syncIn(t, sentId);

		expect(await draftExists(t, written)).toBe(true);
		expect(await draftExists(t, edited)).toBe(true);
	});

	it('settles the same way when a desktop client APPENDs it', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await t.run(async (ctx) => settleOwnerReply(ctx, sentId));

		expect(await draftExists(t, aiDraft)).toBe(false);
		expect((await thread(t, c)).needsReply).toBeUndefined();
	});

	it('keeps an AI draft saved after the reply was sent', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const sentId = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });
		const later = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 20_000, ai: true });

		await syncIn(t, sentId);

		expect(await draftExists(t, later)).toBe(true);
	});

	it('does not treat an auto-reply from the owner as an answer', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
		const vacation = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'sent' });

		await syncIn(t, vacation, { 'Auto-Submitted': 'auto-replied' });

		expect(await draftExists(t, aiDraft)).toBe(true);
		expect((await thread(t, c)).needsReply?.draftSlot).toBeDefined();
	});

	it('does not treat our own draft synced from the Drafts folder as a reply', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await flagWithSlot(t, c, c.askId);
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
		const providerDraft = await addMessage(t, c, { from: OWNER, at: T0 + 10_000, role: 'drafts' });

		await syncIn(t, providerDraft);

		expect(await draftExists(t, aiDraft)).toBe(true);
		expect((await thread(t, c)).needsReply?.draftSlot).toBeDefined();
	});

	it('a delayed sync of an older reply leaves the draft for a newer inbound mail', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const answered = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
		const newerId = await addMessage(t, c, { from: SENDER, at: T0 + 20_000, role: 'inbox' });
		await flagWithSlot(t, c, newerId);
		const forNewer = await seedDraft(t, c, { inReplyTo: newerId, editedAt: T0 + 21_000, ai: true });
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
		const aiDraft = await seedDraft(t, c, { inReplyTo: c.askId, editedAt: T0 + 1_000, ai: true });
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
		expect(await draftExists(t, aiDraft)).toBe(false);

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
