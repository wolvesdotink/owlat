/**
 * A team message held on the agent's questions, and an agent draft with gaps
 * nobody agreed to:
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';
import { pushHarness, setMemberRole } from '../push/__tests__/pushFixtures';
import { HELD_GAP_DRAFT_REASON, UNASKABLE_GAP_REASON } from '../lib/heldGapDraft';
import { transition as threadTransition } from '../inbox/threads/module';
import { withCreationTime } from './helpers/creationTimeSeam';

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

	// A clarification answered in part before this rule, retried through the
	// whole pipeline: a draft that leaves the open fact out is held all the same.
	it('asks again instead of storing a draft while a stored question is open', async () => {
		const t = await pushHarness(modules);
		const open = { id: 'clarify_1', slotType: 'date_time', text: 'When does it ship?' };
		const { messageId } = await seed(t, {
			processingStatus: 'drafting',
			pendingClarification: { questions: [answered, open], askedAt: 1, answeredAt: 2 },
		});

		await agentDrafts(t, messageId, 'Hi Jonas, order #4821 is on its way.');

		const message = await read(t, messageId);
		expect(message?.processingStatus).toBe('awaiting_clarification');
		expect(message?.draftResponse).toBeUndefined();
		expect(message?.pendingClarification?.questions).toEqual([answered, open]);
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
			draftOptions: [gapped, 'Hi Jonas, your refund is on its way.'],
			isDraftGapGuarded: true,
		});

		const [entry] = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(entry?.message._id).toBe(messageId);
		expect(entry?.message.draftResponse).toBeUndefined();
		// The legacy variants go with it: the first one is the held draft.
		expect(entry?.message.draftOptions).toBeUndefined();
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

/** One cron run with its reminder chain; the questions it reminded anyone about. */
async function remindRun(t: Harness): Promise<number> {
	const reminded = async () =>
		new Set(
			await t.run(async (ctx) =>
				(await ctx.db.query('inboxAssignmentNotices').collect())
					.filter((n) => n.isReminder)
					.map((n) => `${n.inboundMessageId}:${n.userId}`)
			)
		);
	const before = await reminded();
	await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const after = await reminded();
	const questions = new Set(
		[...after].filter((key) => !before.has(key)).map((key) => key.split(':')[0])
	);
	return questions.size;
}

describe('the abandoned-question reminder', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const remind = (t: Harness) => remindRun(t);
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

		expect(await remind(t)).toBe(0);
		expect(await noticesFor(t, messageId)).toEqual([]);
	});

	it('asks the readers when the assignee no longer reads the inbox, each once', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, held({ assignedTo: 'user-gone' }));

		expect(await remind(t)).toBe(1);
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
		expect(await remind(t)).toBe(0);
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
	});

	it('asks a new assignee once, and not the readers again', async () => {
		const t = await pushHarness(modules, { 'user-a': 'admin', 'user-b': 'editor' });
		const { messageId } = await seed(t, held({ assignedTo: 'user-a' }));

		expect(await remind(t)).toBe(1);
		expect(await noticesFor(t, messageId)).toEqual(['user-a']);

		// The thread changes hands: user-b becomes a reader and the assignee.
		await setMemberRole(t, 'user-b', 'admin');
		await t.run((ctx) => ctx.db.patch(messageId, { assignedTo: 'user-b' }));
		expect(await remind(t)).toBe(1);
		expect(await noticesFor(t, messageId)).toEqual(['user-a', 'user-b']);
		expect(await remind(t)).toBe(0);
	});
});

describe('the Answer queue behind settled conversations', () => {
	const settle = (t: Harness, threadId: Id<'conversationThreads'>, to: 'resolved' | 'open') =>
		t.run((ctx) =>
			threadTransition(ctx, { threadId, input: { kind: 'status_change', to, source: 'user' } })
		);
	const heldFields = {
		processingStatus: 'awaiting_clarification',
		pendingClarification: {
			questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
			askedAt: 1,
		},
	};

	it('finds the open question behind three settled ones, and counts it', async () => {
		const t = await pushHarness(modules);
		const open = await seed(t, heldFields);
		const settled = [];
		for (let i = 0; i < 3; i++) settled.push(await seed(t, heldFields));
		for (const { threadId } of settled) await settle(t, threadId, 'resolved');

		const queue = await t.query(api.inbox.queries.getReviewQueue, { limit: 3 });
		expect(queue.map((entry) => entry.message._id)).toEqual([open.messageId]);
		expect(await t.query(api.inbox.queries.countReviewQueue, { limit: 3 })).toBe(1);

		// Reopened, a settled one is back in the queue.
		await settle(t, settled[2]!.threadId, 'open');
		expect(await t.query(api.inbox.queries.countReviewQueue, { limit: 3 })).toBe(2);
	});
});

describe('clarification notices in the app', () => {
	it('shows a question only while it waits on an answer on an open conversation', async () => {
		const t = await pushHarness(modules);
		const heldFields = {
			processingStatus: 'awaiting_clarification',
			pendingClarification: { questions: [answered], askedAt: 1 },
		};
		const live = await seed(t, heldFields);
		const answeredOne = await seed(t, { ...heldFields, processingStatus: 'drafting' });
		const closed = await seed(t, heldFields, { status: 'closed' });
		await t.run(async (ctx) => {
			for (const { messageId, threadId } of [live, answeredOne, closed]) {
				await ctx.db.insert('inboxAssignmentNotices', {
					kind: 'clarification',
					inboundMessageId: messageId,
					userId: 'user-a',
					threadId,
					subject: 'Refund',
					assignedByName: 'Jonas',
					createdAt: Date.now(),
				});
			}
		});

		const notices = await t.query(api.inbox.queries.pendingAssignments, {});
		expect(notices.map((n) => n.inboundMessageId)).toEqual([live.messageId]);
	});
});

describe('reminder bookkeeping', () => {
	it('records one reminder notice per person, and drops the notices when the question settles', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await seed(t, {
			processingStatus: 'awaiting_clarification',
			pendingClarification: {
				questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
				askedAt: Date.now() - 2 * DAY,
			},
		});
		const rows = () =>
			t.run(async (ctx) =>
				(await ctx.db.query('inboxAssignmentNotices').collect())
					.filter((n) => n.inboundMessageId === messageId && n.isReminder === true)
					.map((n) => n.userId)
					.sort()
			);

		vi.useFakeTimers();
		await remindRun(t);
		expect(await rows()).toEqual(['user-a', 'user-b']);
		expect((await read(t, messageId))?.pendingClarification).not.toHaveProperty('remindedUserIds');

		// Answered: the cleanup runs on its own, in pages, after the answer.
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'drafting', at: Date.now() },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();
		expect(await rows()).toEqual([]);
		const left = await t.run(async (ctx) => ctx.db.query('inboxAssignmentNotices').collect());
		expect(left.filter((n) => n.inboundMessageId === messageId)).toEqual([]);
	});
});

/** Insert `count` messages on one thread in a single transaction. */
async function seedMany(
	t: Harness,
	threadId: Id<'conversationThreads'>,
	count: number,
	fields: Record<string, unknown>
) {
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			const { threadId: _t, ...row } = createTestInboundMessage({
				contactId: undefined,
				...fields,
			});
			await ctx.db.insert('inboundMessages', { ...row, threadId });
		}
	});
}

const heldNow = () => ({
	processingStatus: 'awaiting_clarification',
	pendingClarification: {
		questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
		askedAt: Date.now(),
	},
});

describe('settlement sync', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Rows parked before the index existed, on conversations settled since, and
	// younger than the reminder window: the cron stamps them all, whatever
	// their age, so they never crowd a live question out of the queue.
	it('finds the open question behind 204 legacy settled rows once the cron has run', async () => {
		vi.useFakeTimers();
		const t = await pushHarness(modules);
		const open = await seed(t, heldNow());
		await t.run(async (ctx) => {
			for (let i = 0; i < 204; i++) {
				const { updatedAt: _u, ...thread } = createTestConversationThread({
					contactId: undefined,
					status: 'resolved',
				});
				const threadId = await ctx.db.insert('conversationThreads', thread);
				const { threadId: _t, ...row } = createTestInboundMessage({
					contactId: undefined,
					...heldNow(),
				});
				await ctx.db.insert('inboundMessages', { ...row, threadId });
			}
		});

		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const queue = await t.query(api.inbox.queries.getReviewQueue, { limit: 3 });
		expect(queue.map((entry) => entry.message._id)).toEqual([open.messageId]);
		expect(await t.query(api.inbox.queries.countReviewQueue, { limit: 3 })).toBe(1);
		const stamped = await t.run(async (ctx) =>
			(await ctx.db.query('inboundMessages').collect()).filter((m) => m.isThreadSettled === true)
		);
		expect(stamped).toHaveLength(204);
	});

	it('settles a long conversation reading only its held messages, not its history', async () => {
		const t = await pushHarness(modules);
		const { messageId, threadId } = await seed(t, heldNow());
		await seedMany(t, threadId, 300, { processingStatus: 'sent' });

		const reads: string[] = [];
		await t.run(async (ctx) => {
			const db = new Proxy(ctx.db, {
				get(target, prop, receiver) {
					if (prop !== 'query') return Reflect.get(target, prop, receiver);
					return (table: string) => {
						const query = target.query(table as never);
						return new Proxy(query, {
							get(q, key, r) {
								if (key !== 'withIndex') return Reflect.get(q, key, r);
								return (name: string, range: never) => {
									reads.push(`${table}.${name}`);
									return q.withIndex(name as never, range);
								};
							},
						});
					};
				},
			});
			await threadTransition({ ...ctx, db } as MutationCtx, {
				threadId,
				input: { kind: 'status_change', to: 'resolved', source: 'user' },
			});
		});

		expect(reads).toContain('inboundMessages.by_thread_and_processing_status');
		expect(reads).not.toContain('inboundMessages.by_thread');
		expect((await read(t, messageId))?.isThreadSettled).toBe(true);
	});

	it('pages a long tail of held messages, and a reopen racing the pages wins', async () => {
		vi.useFakeTimers();
		const t = await pushHarness(modules);
		const { threadId } = await seed(t, heldNow());
		await seedMany(t, threadId, 119, heldNow());
		const flagged = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query('inboundMessages').collect()).filter(
						(m) => m.isThreadSettled === true
					).length
			);
		const settle = (to: 'resolved' | 'open') =>
			t.run((ctx) =>
				threadTransition(ctx, { threadId, input: { kind: 'status_change', to, source: 'user' } })
			);

		await settle('resolved');
		expect(await flagged()).toBe(4);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await flagged()).toBe(120);

		// Settled again, then reopened before the later pages run: every page
		// applies the thread's status at that moment, so none is left flagged.
		await settle('open');
		await settle('resolved');
		await settle('open');
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await flagged()).toBe(0);
	});

	// Rows created in the same instant, the page boundary among them: a
	// timestamp alone cannot tell them apart, the paginate cursor can.
	it.each([
		['a settle', 'open', 'resolved', 120],
		['a reopen', 'resolved', 'open', 0],
	] as const)(
		'%s reaches every held row sharing the boundary time',
		async (_case, from, to, settled) => {
			vi.useFakeTimers();
			const t = await pushHarness(modules);
			const flag = from === 'resolved' ? { isThreadSettled: true } : {};
			const { threadId } = await seed(t, { ...heldNow(), ...flag }, { status: from });
			await withCreationTime(Date.now() + 100, () =>
				seedMany(t, threadId, 119, { ...heldNow(), ...flag })
			);
			const all = () => t.run(async (ctx) => ctx.db.query('inboundMessages').collect());
			expect(new Set((await all()).map((m) => m._creationTime)).size).toBe(2);

			await t.run((ctx) =>
				threadTransition(ctx, { threadId, input: { kind: 'status_change', to, source: 'user' } })
			);
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			expect((await all()).filter((m) => m.isThreadSettled === true)).toHaveLength(settled);
		}
	);
});
