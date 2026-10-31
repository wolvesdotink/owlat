/**
 * The draft-on-arrival loader (mail/ai/draftOnArrivalStore.ts::loadForDraft)
 * must only ever hand the draft model mail someone ELSE sent.
 *
 * On a synced team inbox the queue kept offering drafts that answered our own
 * outreach, written in the customer's voice: the transcript carried no hint of
 * which side wrote what, the flagged message was not marked as the one to
 * answer, and a reply we had already sent from the provider's client did not
 * stop the draft. These pin the three guards.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const OWNER = 'hello@acme.test';
const CUSTOMER = 'chris@example.com';

type Seeded = { threadId: Id<'mailThreads'>; ids: Id<'mailMessages'>[] };

/**
 * One thread holding `messages` in order (oldest first), flagged as needing a
 * reply to the message at `triggerIndex`.
 */
async function seedThread(
	t: TestConvex<typeof schema>,
	messages: Array<{ from: string; body: string; role?: 'inbox' | 'sent' }>,
	triggerIndex: number
): Promise<Seeded> {
	const mailboxId = await seedMailbox(t, { address: OWNER, kind: 'external', scope: 'shared' });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const base = Date.now() - messages.length * 60_000;
	const ids: Id<'mailMessages'>[] = [];
	for (const [index, m] of messages.entries()) {
		ids.push(
			await seedMessage(t, mailboxId, {
				subject: 'Listing paused',
				fromAddress: m.from,
				textBodyInline: m.body,
				role: m.role ?? (m.from === OWNER ? 'sent' : 'inbox'),
				receivedAt: base + index * 60_000,
				rfc822MessageId: `<m${index}@acme.test>`,
			})
		);
	}
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const first = await ctx.db.get(ids[0]!);
		threadId = first!.threadId;
		for (const id of ids.slice(1)) await ctx.db.patch(id, { threadId });
		await ctx.db.patch(threadId, {
			latestMessageId: ids[ids.length - 1],
			needsReply: {
				messageId: ids[triggerIndex]!,
				source: 'heuristic',
				urgency: 'normal',
				detectedAt: Date.now(),
			},
		});
	});
	return { threadId, ids };
}

describe('loadForDraft only answers incoming mail', () => {
	it('labels each side and ends the transcript on the message being answered', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: OWNER, body: 'Hi Chris, we noticed you paused your listing — anything wrong?' },
				{ from: CUSTOMER, body: 'All good, we are closing for winter.' },
			],
			1
		);

		const loaded = await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId });

		expect(loaded?.ownerAddress).toBe(OWNER);
		const context = loaded!.context;
		expect(context).toContain(`From: ${OWNER} — the mailbox owner (you)`);
		expect(context).toContain(`From: ${CUSTOMER} — the other party`);
		// The customer's message is the one to answer, and it comes last.
		const marker = context.indexOf('=== The message to reply to ===');
		expect(marker).toBeGreaterThan(context.indexOf('anything wrong?'));
		expect(context.slice(marker)).toContain('closing for winter');
		expect(context.slice(marker)).not.toContain('anything wrong?');
	});

	it('refuses a trigger the owner wrote', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: CUSTOMER, body: 'Can you check my listing?' },
				{ from: OWNER, body: 'Hi Chris, done — anything else?' },
			],
			1
		);

		expect(
			await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId })
		).toBeNull();
	});

	it('refuses once the owner already answered the trigger from another client', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: CUSTOMER, body: 'Why did you think we removed the listing?' },
				{ from: OWNER, body: 'Sorry, my mistake — it is still live.' },
			],
			0
		);

		expect(
			await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId })
		).toBeNull();
	});
});

const QUESTIONS = [
	{
		id: 'q1',
		slotType: 'date_time',
		text: 'Which delivery date can you offer?',
		origin: { kind: 'email' as const, senderDomain: 'example.com' },
	},
	{
		id: 'q2',
		slotType: 'attachment',
		text: 'Which invoice should go out?',
		origin: { kind: 'email' as const, senderDomain: 'example.com' },
		answerKind: 'file' as const,
	},
];

/** Put open questions on the thread's flag. */
async function askQuestions(t: TestConvex<typeof schema>, threadId: Id<'mailThreads'>) {
	await t.run(async (ctx) => {
		const thread = await ctx.db.get(threadId);
		await ctx.db.patch(threadId, {
			needsReply: {
				...thread!.needsReply!,
				clarification: { isNeeded: true, askedAt: Date.now(), questions: QUESTIONS },
			},
		});
	});
}

describe('no arrival draft while the owner has questions to answer', () => {
	it('loadForDraft skips a thread with open questions', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'When can you deliver, and can you send the invoice?' }],
			0
		);
		await askQuestions(t, threadId);

		expect(
			await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId })
		).toBeNull();
	});

	it('persistDraftSlot drops a draft that raced the questions', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'When can you deliver?' }],
			0
		);
		await askQuestions(t, threadId);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[0]!,
			draft: 'Hi Chris, we can deliver on [[delivery date]].',
			confidence: 0.8,
		});

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.needsReply?.draftSlot).toBeUndefined();
	});

	it('persistDraftSlot stores no draft with a gap, whoever wrote it: the gap is asked', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'When can you deliver?' }],
			0
		);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[0]!,
			draft: 'Hi Chris, we can deliver on [[delivery date]].',
			confidence: 0.8,
		});

		const flag = (await t.run((ctx) => ctx.db.get(threadId)))?.needsReply;
		expect(flag?.draftSlot).toBeUndefined();
		expect(flag?.clarification?.questions).toEqual([
			expect.objectContaining({
				id: 'gap_0',
				text: 'delivery date',
				origin: { kind: 'email', senderDomain: 'example.com' },
			}),
		]);
	});

	it('persistDraftSlot stores nothing for a gap no question may ask for', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'Can you log in for me?' }],
			0
		);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[0]!,
			draft: 'Sure, I will use [[your password]].',
			confidence: 0.8,
		});

		const flag = (await t.run((ctx) => ctx.db.get(threadId)))?.needsReply;
		expect(flag?.draftSlot).toBeUndefined();
		expect(flag?.clarification).toBeUndefined();
	});

	it('holdForGapQuestions turns a draft with gaps into questions instead of a slot', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'When can you deliver?' }],
			0
		);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.holdForGapQuestions, {
			threadId,
			triggerMessageId: ids[0]!,
			questions: [{ ...QUESTIONS[0]!, id: 'gap_0' }],
		});

		const flag = (await t.run((ctx) => ctx.db.get(threadId)))?.needsReply;
		expect(flag?.draftSlot).toBeUndefined();
		expect(flag?.clarification?.isNeeded).toBe(true);
		expect(flag?.clarification?.questions.map((q) => q.id)).toEqual(['gap_0']);
	});

	it('holdForGapQuestions never replaces questions already asked', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'When can you deliver?' }],
			0
		);
		await askQuestions(t, threadId);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.holdForGapQuestions, {
			threadId,
			triggerMessageId: ids[0]!,
			questions: [{ ...QUESTIONS[0]!, id: 'gap_0' }],
		});

		const flag = (await t.run((ctx) => ctx.db.get(threadId)))?.needsReply;
		expect(flag?.clarification?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
	});
});

describe('the slot and its plan land in one commit', () => {
	const plan = {
		threadRevision: 1,
		itemRevisions: [],
		stances: [],
		coverage: [],
		fileClaims: [],
		newPromises: [],
		draftHash: 'slot-hash',
		verdict: 'covered' as const,
		planRevision: 0,
		deletionEpoch: 0,
		attachmentSetHash: 'none',
		isCheckIncomplete: false,
	};
	const arrivalPlans = (t: TestConvex<typeof schema>) =>
		t.run(async (ctx) =>
			(await ctx.db.query('draftResponsePlans').collect()).filter(
				(row) => row.draftKind === 'arrivalDraft'
			)
		);

	it('stores the plan with the slot it is bound to', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[{ from: CUSTOMER, body: 'Does Friday work?' }],
			0
		);

		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[0]!,
			draft: 'Hi Chris, Friday works.',
			confidence: 0.8,
			plan,
		});

		expect((await t.run((ctx) => ctx.db.get(threadId)))?.needsReply?.draftSlot?.draft).toBe(
			'Hi Chris, Friday works.'
		);
		expect(await arrivalPlans(t)).toEqual([
			expect.objectContaining({ mailThreadId: threadId, draftHash: 'slot-hash' }),
		]);
	});

	it('stores no plan for a slot the guards refused, even over an older slot', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(
			t,
			[
				{ from: CUSTOMER, body: 'Does Friday work?' },
				{ from: CUSTOMER, body: 'Or Monday?' },
			],
			1
		);
		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[1]!,
			draft: 'Hi Chris, Monday works.',
			confidence: 0.8,
		});

		// A run that drafted for the earlier trigger lands late.
		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: ids[0]!,
			draft: 'Hi Chris, Friday works.',
			confidence: 0.8,
			plan,
		});

		expect((await t.run((ctx) => ctx.db.get(threadId)))?.needsReply?.draftSlot?.draft).toBe(
			'Hi Chris, Monday works.'
		);
		expect(await arrivalPlans(t)).toEqual([]);
	});
});
