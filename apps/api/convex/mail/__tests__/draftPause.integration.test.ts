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

/** A saved reply draft; `baseline` makes it an AI draft (the composer recorded the AI text). */
async function seedDraft(
	t: T,
	c: Conversation,
	opts: { baseline?: string } = {}
): Promise<Id<'mailDrafts'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId: c.mailboxId,
			threadId: c.threadId,
			inReplyToMessageId: c.askId,
			toAddresses: [SENDER],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: OWNER,
			subject: 'Re: Can you send the report?',
			bodyHtml: '<p>Reply</p>',
			...(opts.baseline
				? { aiDraftBaseline: { text: opts.baseline, capturedAt: Date.now() } }
				: {}),
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

	it('counts a discarded copy of the offered reply once; a later reply or copy never again (F2)', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const leftover = await seedDraft(t, c, { baseline: SLOT });
		await t.mutation(api.mail.drafts.discard, {
			draftId: await seedDraft(t, c, { baseline: SLOT }),
		});
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
		expect((await t.run(async (ctx) => ctx.db.get(c.threadId)))?.needsReply).toMatchObject({
			isDraftUsageCounted: true,
		});

		// The same arrival reply: its other copy, and a reply sent without it.
		await t.mutation(api.mail.drafts.discard, { draftId: leftover });
		await send(t, await seedDraft(t, c));
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(1);
	});

	it('counts discard-then-archive of each arrival reply (F2)', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		for (let round = 1; round <= 2; round++) {
			await t.mutation(api.mail.drafts.discard, {
				draftId: await seedDraft(t, c, { baseline: SLOT }),
			});
			// Archive clears the flag; the next message brings a new slot.
			await t.run(async (ctx) => ctx.db.patch(c.threadId, { needsReply: undefined }));
			expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(round);
			await t.run(async (ctx) =>
				ctx.db.patch(c.threadId, {
					needsReply: {
						messageId: c.askId,
						detectedAt: Date.now(),
						source: 'llm' as const,
						urgency: 'normal' as const,
						draftSlot: { draft: SLOT, confidence: 0.9, generatedAt: Date.now() },
					},
				})
			);
		}
	});

	it('counts a reply sent without the offered AI reply once, and its leftover copy never', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		const leftover = await seedDraft(t, c, { baseline: SLOT });
		const other = await seedDraft(t, c, { baseline: OTHER_AI });
		await send(t, await seedDraft(t, c));
		// The arrival reply and the other AI draft both went unused.
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(2);
		await t.mutation(api.mail.drafts.discard, { draftId: leftover });
		await t.mutation(api.mail.drafts.discard, { draftId: other });
		expect((await profile(t, c.mailboxId))?.unusedDraftStreak).toBe(2);
	});

	it('counts the AI draft taken back out in the editor, and its send is not AI-based (F1)', async () => {
		const t = convexTest(schema, modules);
		const c = await seedConversation(t);
		await seedProfile(t, c.mailboxId, { address: SENDER, unusedDraftStreak: 2 });
		const draftId = await seedDraft(t, c, { baseline: SLOT });

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
