/**
 * The unused-draft pause (SPEC §7, mail/draftPause.ts) through the real draft
 * lifecycle: an AI draft discarded (the row, or taken back out in the editor)
 * counts, so does a reply sent without the AI reply the thread offered
 * (through Owlat or from another client), and no logical draft ever counts
 * twice. An AI-based send resets the streak, also while paused. The fifth unused draft pauses draft-on-arrival for that sender
 * until Resume. Pauses and resets are logged operations; a team inbox keeps
 * no streak.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { seedProfile, type T } from '../senders/__tests__/senders.testlib';
import { settleOwnerReply } from '../answeredReply';
import { aiTextToHtml } from '@owlat/shared/answerMode';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const OWNER = 'me@owlat.test';
const SENDER = 'sam@acme.test';
const SLOT = 'Hi Sam,\n\nhere is the report.\n\nBest';
const OTHER_AI = 'Hi Sam,\n\nI will send it tomorrow.\n\nBest';

interface Conversation {
	mailboxId: Id<'mailboxes'>;
	threadId: Id<'mailThreads'>;
	askId: Id<'mailMessages'>;
}

async function seedConversation(t: T, opts: { scope?: 'shared'; slot?: boolean } = {}) {
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		address: OWNER,
		...(opts.scope ? { scope: opts.scope } : {}),
	});
	for (const role of ['inbox', 'sent', 'drafts'] as const) await seedFolder(t, mailboxId, role);
	const askId = await seedMessage(t, mailboxId, {
		subject: 'Can you send the report?',
		fromAddress: SENDER,
		receivedAt: Date.now() - 60_000,
	});
	const threadId = await t.run(async (ctx) => {
		const ask = (await ctx.db.get(askId))!;
		await ctx.db.patch(ask.threadId, {
			latestMessageId: askId,
			needsReply: {
				messageId: askId,
				detectedAt: Date.now(),
				source: 'llm' as const,
				urgency: 'normal' as const,
				...(opts.slot !== false
					? { draftSlot: { draft: SLOT, confidence: 0.9, generatedAt: Date.now() } }
					: {}),
			},
		});
		return ask.threadId;
	});
	return { mailboxId, threadId, askId } satisfies Conversation;
}

/** The key of the reply the conversation offers for `askId`. */
function offerOf(c: Conversation, askId: Id<'mailMessages'> = c.askId): string {
	return `${c.threadId}:${askId}`;
}

/**
 * A saved reply draft; `baseline` makes it an AI draft (the composer recorded
 * the AI text), `offerKey` a copy of the thread's offered reply.
 */
async function seedDraft(
	t: T,
	c: Conversation,
	opts: { baseline?: string; offerKey?: string; inReplyTo?: Id<'mailMessages'> } = {}
): Promise<Id<'mailDrafts'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId: c.mailboxId,
			threadId: c.threadId,
			inReplyToMessageId: opts.inReplyTo ?? c.askId,
			toAddresses: [SENDER],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: OWNER,
			subject: 'Re: Can you send the report?',
			bodyHtml: '<p>Reply</p>',
			...(opts.baseline
				? { aiDraftBaseline: { text: opts.baseline, capturedAt: Date.now() } }
				: {}),
			...(opts.offerKey ? { offerKey: opts.offerKey } : {}),
			attachments: [],
			state: 'draft',
			lastEditedAt: Date.now(),
			createdAt: Date.now(),
		})
	);
}

/** The send's `→ sent` (past the undo window). */
async function send(t: T, draftId: Id<'mailDrafts'>): Promise<void> {
	const rawStorageId = await t.run(async (ctx) => {
		await ctx.db.patch(draftId, { state: 'pending_send', undoToken: `undo-${draftId}` });
		return ctx.storage.store(new Blob(['raw-out']));
	});
	const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
		draftId,
		input: {
			to: 'sent',
			at: Date.now(),
			context: {
				rawStorageId,
				rawSize: 7,
				rfc822MessageId: `reply-${draftId}@owlat.test`,
				references: [],
				bodyHtml: '<p>Sent</p>',
				bodyText: 'Sent',
				attachmentsMeta: [],
			},
		},
	});
	if (!outcome.ok) throw new Error(`send refused: ${outcome.reason}`);
}

async function profile(
	t: T,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailSenderProfiles'> | null> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailSenderProfiles')
			.withIndex('by_mailbox_last', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		return rows.find((row) => row.address === SENDER) ?? null;
	});
}

async function operations(t: T, mailboxId: Id<'mailboxes'>) {
	return await t.run(async (ctx) => {
		const ops = await ctx.db
			.query('mailArrivalOperations')
			.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		return await Promise.all(
			ops.map(async (op) => ({
				op,
				changes: await ctx.db
					.query('mailArrivalOperationChanges')
					.withIndex('by_operation', (q) => q.eq('operationId', op._id))
					.collect(),
			}))
		);
	});
}

describe('the unused-draft streak', () => {
	it('counts an AI draft discarded while its reply is owed, once', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t, { slot: false });
		const draftId = await seedDraft(t, c, { baseline: OTHER_AI });

		await t.mutation(api.mail.drafts.discard, { draftId });
		await t.mutation(api.mail.drafts.discard, { draftId });

		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		// A plain increment is not an operation.
		expect(await operations(t, c.mailboxId)).toEqual([]);
	});

	it('does not count a discarded draft a person wrote', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await t.mutation(api.mail.drafts.discard, { draftId: await seedDraft(t, c) });
		expect(await profile(t, c.mailboxId)).toBeNull();
	});

	it('counts a discarded copy of the offered reply once; a later reply or copy never again', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const copy = { baseline: SLOT, offerKey: offerOf(c) };
		const leftover = await seedDraft(t, c, copy);
		await t.mutation(api.mail.drafts.discard, { draftId: await seedDraft(t, c, copy) });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		expect((await t.run(async (ctx) => ctx.db.get(c.threadId)))?.draftOfferCountedKeys).toEqual([
			offerOf(c),
		]);

		// The same offer: its other copy, and a reply sent without it.
		await t.mutation(api.mail.drafts.discard, { draftId: leftover });
		await send(t, await seedDraft(t, c));
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
	});

	it('counts the offer once with 49 older drafts in the thread (r3 F1)', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		for (let i = 0; i < 49; i++) await seedDraft(t, c);
		const copy = { baseline: SLOT, offerKey: offerOf(c) };
		const copyA = await seedDraft(t, c, copy);
		const copyB = await seedDraft(t, c, copy);
		await t.mutation(api.mail.drafts.discard, { draftId: copyA });
		await t.run(async (ctx) => ctx.db.patch(c.threadId, { needsReply: undefined })); // archive
		await t.mutation(api.mail.drafts.discard, { draftId: copyB });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
	});

	it("counts the offer once when a copy's baseline is recorded after the archive (r3 F2)", async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await t.mutation(api.mail.drafts.discard, {
			draftId: await seedDraft(t, c, { baseline: SLOT, offerKey: offerOf(c) }),
		});
		// Another composer applies the offer: its body save lands, then the archive,
		// then its baseline save. Both writes carry the offer key.
		const copyB = await seedDraft(t, c);
		await t.mutation(api.mail.drafts.update, {
			draftId: copyB,
			bodyHtml: aiTextToHtml(SLOT),
			aiText: SLOT,
			offerKey: offerOf(c),
		});
		await t.run(async (ctx) => ctx.db.patch(c.threadId, { needsReply: undefined })); // archive
		await t.mutation(api.mail.drafts.update, {
			draftId: copyB,
			aiBaseline: SLOT,
			offerKey: offerOf(c),
		});
		expect((await t.run(async (ctx) => ctx.db.get(copyB)))?.offerKey).toBe(offerOf(c));
		await t.mutation(api.mail.drafts.discard, { draftId: copyB });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
	});

	it("keeps an offer key only for the draft's own thread", async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const draftId = await seedDraft(t, c);
		await t.mutation(api.mail.drafts.update, {
			draftId,
			aiBaseline: SLOT,
			offerKey: 'mailThreads_other:message',
		});
		expect((await t.run(async (ctx) => ctx.db.get(draftId)))?.offerKey).toBeUndefined();
	});

	it('counts discard-then-archive of each new offer', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		let askId = c.askId;
		for (let round = 1; round <= 2; round++) {
			await t.mutation(api.mail.drafts.discard, {
				draftId: await seedDraft(t, c, {
					baseline: SLOT,
					offerKey: offerOf(c, askId),
					inReplyTo: askId,
				}),
			});
			expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(round);
			// Archive, then their next message brings a new offer.
			askId = await t.run(async (ctx) => {
				const { _id, _creationTime, ...base } = (await ctx.db.get(c.askId))!;
				const next = await ctx.db.insert('mailMessages', {
					...base,
					rfc822MessageId: `<next-${round}@acme.test>`,
				});
				await ctx.db.patch(c.threadId, {
					needsReply: {
						messageId: next,
						detectedAt: Date.now(),
						source: 'llm' as const,
						urgency: 'normal' as const,
						draftSlot: { draft: SLOT, confidence: 0.9, generatedAt: Date.now() },
					},
				});
				return next;
			});
		}
	});

	it('counts a reply sent without the offered reply once; other AI drafts when discarded', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const leftover = await seedDraft(t, c, { baseline: SLOT, offerKey: offerOf(c) });
		const other = await seedDraft(t, c, { baseline: OTHER_AI });
		await send(t, await seedDraft(t, c));
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		await t.mutation(api.mail.drafts.discard, { draftId: leftover });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		await t.mutation(api.mail.drafts.discard, { draftId: other });
		await t.mutation(api.mail.drafts.discard, { draftId: other });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(2);
	});

	it('counts the AI draft taken back out in the editor, and its send is not AI-based', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await seedProfile(t, c.mailboxId, { address: SENDER, unusedDraftStreak: 2 });
		const draftId = await seedDraft(t, c, { baseline: SLOT, offerKey: offerOf(c) });

		await t.mutation(api.mail.draftPause.markAiDraftDiscarded, { draftId });
		await t.mutation(api.mail.draftPause.markAiDraftDiscarded, { draftId });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(3);

		// The person writes their own reply in the same row and sends it.
		await send(t, draftId);
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(3);
		expect(await operations(t, c.mailboxId)).toEqual([]);
	});

	it('treats a send as AI-based again once an AI draft went back in', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t, { slot: false });
		await seedProfile(t, c.mailboxId, { address: SENDER, unusedDraftStreak: 2 });
		const draftId = await seedDraft(t, c, { baseline: OTHER_AI });
		await t.mutation(api.mail.draftPause.markAiDraftDiscarded, { draftId });
		await t.mutation(api.mail.drafts.update, {
			draftId,
			bodyHtml: aiTextToHtml(OTHER_AI),
			aiText: OTHER_AI,
		});
		expect((await t.run(async (ctx) => ctx.db.get(draftId)))?.aiDraftDiscardedAt).toBeUndefined();
		await send(t, draftId);
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(0);
	});

	it('counts a reply from another client when the thread offered an AI reply', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const replyId = await seedMessage(t, c.mailboxId, {
			subject: 'Re: Can you send the report?',
			fromAddress: OWNER,
			role: 'sent',
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(replyId, { threadId: c.threadId });
			await settleOwnerReply(ctx, replyId);
			await settleOwnerReply(ctx, replyId);
		});
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		expect((await t.run(async (ctx) => ctx.db.get(c.threadId)))?.needsReply).toBeUndefined();
	});

	it('resets on an AI-based send, as a logged operation', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await seedProfile(t, c.mailboxId, { address: SENDER, unusedDraftStreak: 3 });

		await send(t, await seedDraft(t, c, { baseline: SLOT }));

		const after = (await profile(t, c.mailboxId))!;
		expect(after.unusedDraftStreak).toBe(0);
		const [logged] = await operations(t, c.mailboxId);
		expect(logged!.op).toMatchObject({ kind: 'draft_pause', actor: 'system', changeCount: 1 });
		expect(logged!.changes.map((row) => row.change)).toEqual([
			{
				kind: 'senderDraftPause',
				senderDigest: after.senderDigest,
				before: { unusedDraftStreak: 3 },
				after: { unusedDraftStreak: 0 },
			},
		]);
		expect(after.lastOperationId).toBe(logged!.op._id);
	});

	it('keeps no streak in a team inbox', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t, { scope: 'shared' });
		await send(t, await seedDraft(t, c));
		expect(await profile(t, c.mailboxId)).toBeNull();
		expect(await operations(t, c.mailboxId)).toEqual([]);
	});
});

describe('the pause', () => {
	it('pauses draft-on-arrival at the fifth unused draft until Resume', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t, { slot: false });
		await seedProfile(t, c.mailboxId, { address: SENDER, unusedDraftStreak: 4 });
		const load = () =>
			t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId: c.threadId });
		expect(await load()).not.toBeNull();

		await t.mutation(api.mail.drafts.discard, {
			draftId: await seedDraft(t, c, { baseline: OTHER_AI }),
		});

		const paused = (await profile(t, c.mailboxId))!;
		expect(paused.autoDraftPausedAt).toBeTypeOf('number');
		expect(paused.unusedDraftStreak).toBe(5);
		const [logged] = await operations(t, c.mailboxId);
		expect(logged!.op.kind).toBe('draft_pause');
		expect(logged!.changes[0]!.change).toMatchObject({
			before: { unusedDraftStreak: 4 },
			after: { autoDraftPausedAt: paused.autoDraftPausedAt, unusedDraftStreak: 5 },
		});

		// Draft-on-arrival skips the sender, and a run already drafting stores nothing.
		expect(await load()).toBeNull();
		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId: c.threadId,
			triggerMessageId: c.askId,
			draft: SLOT,
			confidence: 0.9,
		});
		expect((await t.run(async (ctx) => ctx.db.get(c.threadId)))?.needsReply?.draftSlot).toBe(
			undefined
		);

		// An AI-based send resets the streak while paused, as a new operation:
		// the pause's undo now fails its guard (F7). The pause waits for Resume.
		await send(t, await seedDraft(t, c, { baseline: OTHER_AI }));
		const reset = (await profile(t, c.mailboxId))!;
		expect(reset).toMatchObject({
			autoDraftPausedAt: paused.autoDraftPausedAt,
			unusedDraftStreak: 0,
		});
		const resetOp = (await operations(t, c.mailboxId)).find((o) => o.op._id !== logged!.op._id);
		expect(resetOp!.changes[0]!.change).toMatchObject({
			before: { autoDraftPausedAt: paused.autoDraftPausedAt, unusedDraftStreak: 5 },
			after: { autoDraftPausedAt: paused.autoDraftPausedAt, unusedDraftStreak: 0 },
		});
		expect(reset.lastOperationId).toBe(resetOp!.op._id);

		// Resume clears both fields, as its own operation.
		const resumed = await t.mutation(api.mail.senders.status.resumeDrafts, {
			target: { mailboxId: c.mailboxId, senderDigest: paused.senderDigest },
		});
		const cleared = (await profile(t, c.mailboxId))!;
		expect(cleared.autoDraftPausedAt).toBeUndefined();
		expect(cleared.unusedDraftStreak).toBe(0);
		expect(cleared.lastOperationId).toBe(resumed.operationId);
	});

	it('leaves the clarification questions alone while paused', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t, { slot: false });
		await seedProfile(t, c.mailboxId, {
			address: SENDER,
			unusedDraftStreak: 5,
			autoDraftPausedAt: Date.now(),
		});
		await t.mutation(internal.mail.ai.draftOnArrivalStore.holdForGapQuestions, {
			threadId: c.threadId,
			triggerMessageId: c.askId,
			questions: [{ id: 'q1', slotType: 'date', text: 'Which date works?' }],
		});
		const flag = (await t.run(async (ctx) => ctx.db.get(c.threadId)))?.needsReply;
		expect(flag?.clarification?.questions).toHaveLength(1);
	});
});
