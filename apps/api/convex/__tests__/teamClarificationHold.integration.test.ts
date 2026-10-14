/**
 * A team message held on the agent's questions, and an agent draft with gaps
 * nobody agreed to (#1343):
 *
 *   - the write-side fence: `recordDraftOutput` stores a draft with gaps only
 *     with the owner's consent; otherwise its gaps become questions, or a
 *     credential-only gap leaves the reply to a person with no AI draft;
 *   - the read side: such a draft stored before the fence is not shown;
 *   - the Answer queue lists a held message and counts it, while its
 *     conversation is open;
 *   - the reminder asks each person who has to answer once, skips settled
 *     conversations, and replaces an assignee who no longer reads the inbox.
 */
import type { TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import type schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';
import { pushHarness, setMemberRole } from '../push/__tests__/pushFixtures';
import { HELD_GAP_DRAFT_REASON, UNASKABLE_GAP_REASON } from '../lib/heldGapDraft';

vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getBetterAuthSessionWithRole: vi.fn(async () => ({
		userId: 'user-a',
		activeOrganizationId: 'org-1',
		role: 'owner',
	})),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;
const gapped = 'Hi Jonas, your refund of [[refund amount]] is on its way.';
const answered = {
	id: 'clarify_0',
	slotType: 'factual_lookup',
	text: 'Which order?',
	answer: { value: '#4821', source: 'user' as const, at: 2 },
};

async function seed(
	t: Harness,
	fields: Record<string, unknown> = {},
	thread: Record<string, unknown> = {}
) {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'jonas@example.com' })
		);
		const { updatedAt: _u, ...row } = createTestConversationThread({ contactId, ...thread });
		const threadId = await ctx.db.insert('conversationThreads', row);
		const { threadId: _t, ...message } = createTestInboundMessage({
			contactId,
			from: 'Jonas Berg <jonas@example.com>',
			to: 'support@owlat.example',
			subject: 'Refund',
			...fields,
		});
		const messageId = await ctx.db.insert('inboundMessages', { ...message, threadId });
		return { messageId: messageId as Id<'inboundMessages'>, threadId };
	});
}

const read = (t: Harness, id: Id<'inboundMessages'>) => t.run((ctx) => ctx.db.get(id));

const agentDrafts = (
	t: Harness,
	id: Id<'inboundMessages'>,
	draftResponse: string,
	extra: { isGapsAccepted?: boolean } = {}
) =>
	t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
		inboundMessageId: id,
		draftResponse,
		draftSubject: 'Re: Refund',
		confidenceScore: 0.8,
		...extra,
	});

describe('the write-side fence', () => {
	it('asks about a gap nobody agreed to instead of storing the draft', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, {
			processingStatus: 'drafting',
			pendingClarification: { questions: [answered], askedAt: 1, answeredAt: 2 },
		});

		await agentDrafts(t, messageId, gapped);

		const message = await read(t, messageId);
		expect(message?.processingStatus).toBe('awaiting_clarification');
		expect(message?.draftResponse).toBeUndefined();
		expect(message?.pendingClarification?.questions).toEqual([
			answered,
			expect.objectContaining({ id: 'gap_0', text: 'refund amount', answerKind: 'text' }),
		]);
	});

	it('leaves a credential-only gap to a person, with no AI draft', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, { processingStatus: 'drafting' });

		await agentDrafts(t, messageId, 'Log in with [[the customer password]] to see it.');

		const message = await read(t, messageId);
		expect(message?.processingStatus).toBe('draft_ready');
		expect(message?.draftResponse).toBe('');
		expect(message?.isAutoSendBlocked).toBe(true);
		expect(message?.agentDecision?.reason).toBe(UNASKABLE_GAP_REASON);
	});

	it.each([
		['"Draft with what I have"', { isGapsAccepted: true }, {}],
		['asking turned off', {}, { isGapsAccepted: true }],
	] as const)('stores gaps the owner agreed to: %s', async (_case, pending, extra) => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, {
			processingStatus: 'drafting',
			pendingClarification: { questions: [answered], askedAt: 1, answeredAt: 2, ...pending },
		});

		await agentDrafts(t, messageId, gapped, extra);

		const message = await read(t, messageId);
		expect(message?.processingStatus).toBe('drafting');
		expect(message?.draftResponse).toBe(gapped);
		expect(message?.isDraftGapGuarded).toBe(true);
		expect(message?.isDraftGapsAccepted).toBe(true);
	});
});

describe('an agent draft stored with gaps before the fence', () => {
	it('is not shown in the review queue or the thread, and says why', async () => {
		const t = await pushHarness(modules);
		const { messageId, threadId } = await seed(t, {
			processingStatus: 'draft_ready',
			draftResponse: gapped,
			isDraftGapGuarded: true,
		});

		const [entry] = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(entry?.message._id).toBe(messageId);
		expect(entry?.message.draftResponse).toBeUndefined();
		expect(entry?.message.agentDecision?.reason).toBe(HELD_GAP_DRAFT_REASON);

		const thread = await t.query(api.inbox.queries.getThread, { threadId });
		expect(thread?.messages[0]?.draftResponse).toBeUndefined();
	});

	it.each([
		['the owner agreed to', { isDraftGapsAccepted: true }],
		['a person saved', { draftSavedAt: 5 }],
		['a person took over', { manualTakeoverAt: 5 }],
	] as const)('is shown when %s it', async (_case, fields) => {
		const t = await pushHarness(modules);
		await seed(t, {
			processingStatus: 'draft_ready',
			draftResponse: gapped,
			isDraftGapGuarded: true,
			...fields,
		});

		const [entry] = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(entry?.message.draftResponse).toBe(gapped);
	});
});

describe('the Answer queue', () => {
	it('lists a held message with its questions and counts it, while its thread is open', async () => {
		const t = await pushHarness(modules);
		const { messageId, threadId } = await seed(t, {
			processingStatus: 'awaiting_clarification',
			pendingClarification: {
				questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
				askedAt: 1,
			},
		});

		const queue = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(queue.map((entry) => entry.message._id)).toEqual([messageId]);
		expect(queue[0]?.message.pendingClarification?.questions).toHaveLength(1);
		expect(await t.query(api.inbox.queries.countReviewQueue, {})).toBe(1);

		await t.run((ctx) => ctx.db.patch(threadId, { status: 'resolved' }));
		expect(await t.query(api.inbox.queries.getReviewQueue, {})).toEqual([]);
		expect(await t.query(api.inbox.queries.countReviewQueue, {})).toBe(0);
	});
});

describe('the abandoned-question reminder', () => {
	const remind = (t: Harness) =>
		t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
	const noticesFor = (t: Harness, id: Id<'inboundMessages'>) =>
		t.run(async (ctx) =>
			(await ctx.db.query('inboxAssignmentNotices').collect())
				.filter((n) => n.inboundMessageId === id)
				.map((n) => n.userId)
				.sort()
		);
	const held = (fields: Record<string, unknown> = {}) => ({
		processingStatus: 'awaiting_clarification',
		pendingClarification: {
			questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
			askedAt: Date.now() - 2 * DAY,
		},
		...fields,
	});

	it('skips a conversation closed before the cron ran', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, held(), { status: 'closed' });

		expect(await remind(t)).toEqual({ reminded: 0 });
		expect(await noticesFor(t, messageId)).toEqual([]);
	});

	it('asks the readers when the assignee no longer reads the inbox, each once', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, held({ assignedTo: 'user-gone' }));

		expect(await remind(t)).toEqual({ reminded: 1 });
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
		expect(await remind(t)).toEqual({ reminded: 0 });
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
	});

	it('asks a new assignee once, and not the readers again', async () => {
		const t = await pushHarness(modules, { 'user-a': 'admin', 'user-b': 'editor' });
		const { messageId } = await seed(t, held({ assignedTo: 'user-a' }));

		expect(await remind(t)).toEqual({ reminded: 1 });
		expect(await noticesFor(t, messageId)).toEqual(['user-a']);

		// The thread changes hands: user-b becomes a reader and the assignee.
		await setMemberRole(t, 'user-b', 'admin');
		await t.run((ctx) => ctx.db.patch(messageId, { assignedTo: 'user-b' }));
		expect(await remind(t)).toEqual({ reminded: 1 });
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
		expect(await remind(t)).toEqual({ reminded: 0 });
	});
});
