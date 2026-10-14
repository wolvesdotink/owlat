/**
 * #1346 for the Team Inbox: once the agent reply to a newer message of a
 * thread is sent, the older messages the agent was still drafting or asking
 * about are answered too. Their AI draft and questions go (archived,
 * `answered_in_thread`, kept in a stash) and a late generation cannot write
 * them back; a later bounce of that reply reopens them, and the retention
 * window drops the stash. A person's edited draft, a newer message, and every
 * message of a reply that failed to send stay as they were.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { createTestContact, flushScheduled } from '../../__tests__/factories';
import { pushHarness } from '../../push/__tests__/pushFixtures';
import { appendDraftRevision } from '../../inbox/draftRevisions';
import { isReplyOwed } from '../../inbox/sla/threadClock';
import { recordInboundMirror } from '../../unifiedMessages';
import * as clarificationAnswers from '../../inbox/clarificationAnswers';

// The team draft-gap fence's predicate (inbox/stepOutputs.ts), wrapped so a test
// can tell whether the fence was reached at all. Behaviour is unchanged.
vi.mock('../../inbox/clarificationAnswers', async (importOriginal) => {
	const actual = await importOriginal<typeof clarificationAnswers>();
	return { ...actual, hasUnconsentedOpenQuestion: vi.fn(actual.hasUnconsentedOpenQuestion) };
});
import { modules } from './helpers.testlib';
import { ANSWERED_RETENTION_MS, MAX_TRACKED_ANSWERS } from '../answeredReply';

const NOW = 1_700_000_000_000;
const workId = 'test-work-id' as WorkId;

afterEach(async () => {
	vi.restoreAllMocks();
	await flushScheduled();
});

type T = TestConvex<typeof schema>;
type Inbound = Doc<'inboundMessages'>;

interface Thread {
	threadId: Id<'conversationThreads'>;
	contactId: Id<'contacts'>;
}

async function seedThread(t: T): Promise<Thread> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Order',
			normalizedSubject: 'order',
			contactId,
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 3,
			lastMessageAt: NOW,
			firstMessageAt: NOW - 10_000,
			createdAt: NOW - 10_000,
		});
		return { threadId, contactId };
	});
}

async function seedInbound(
	t: T,
	th: Thread,
	fields: Partial<Inbound> & Pick<Inbound, 'processingStatus' | 'receivedAt'>
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			to: 'support@example.com',
			from: 'Customer <customer@example.com>',
			subject: 'Order',
			textBody: 'Where is my order?',
			messageId: `<m${fields.receivedAt}@example.com>`,
			threadId: th.threadId,
			contactId: th.contactId,
			...fields,
		})
	);
}

/** The approved agent reply to `inboundMessageId`, completed by the worker. */
async function completeReply(
	t: T,
	th: Thread,
	inboundMessageId: Id<'inboundMessages'>,
	outcome: 'sent' | 'failed'
): Promise<Id<'transactionalSends'>> {
	const sendId = await t.run(async (ctx) =>
		ctx.db.insert('transactionalSends', {
			kind: 'agent_reply' as const,
			email: 'customer@example.com',
			status: 'queued',
			queuedAt: NOW,
			inboundMessageId,
			contactId: th.contactId,
			subject: 'Re: Order',
		})
	);
	await t.mutation(internal.delivery.sendCompletion.completeSend, {
		result:
			outcome === 'sent'
				? {
						kind: 'success' as const,
						returnValue: {
							kind: 'accepted',
							providerMessageId: 'pm-1',
							providerType: 'mta',
							sendLatencyMs: 5,
							isCustodyHandoff: false,
						},
					}
				: { kind: 'failed' as const, error: 'relay refused' },
		context: { sendRef: { kind: 'transactional', id: sendId } },
		workId,
	});
	return sendId;
}

/** The recipient's server reports a bounce for a reply already sent. */
async function laterBounce(t: T, sendId: Id<'transactionalSends'>): Promise<void> {
	await t.mutation(internal.delivery.sendLifecycle.transition, {
		send: { kind: 'transactional', id: sendId },
		transition: { to: 'bounced', at: NOW + 60_000, bounceType: 'hard' },
	});
}

async function get(t: T, id: Id<'inboundMessages'>): Promise<Inbound> {
	return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

describe('a Team Inbox reply to a newer message', () => {
	it('settles the older messages the agent was drafting or asking about', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const olderDraft = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const olderAsking = await seedInbound(t, th, {
			processingStatus: 'awaiting_clarification',
			pendingClarification: { questions: [], askedAt: NOW - 2_500 },
			receivedAt: NOW - 2_000,
		});
		const olderEdited = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Edited by a teammate.',
			isDraftEdited: true,
			receivedAt: NOW - 1_500,
		});
		const olderInFlight = await seedInbound(t, th, {
			processingStatus: 'drafting',
			receivedAt: NOW - 1_000,
		});
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All three orders ship Monday.',
			receivedAt: NOW,
		});
		const newer = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Thanks for the update.',
			receivedAt: NOW + 5_000,
		});

		await completeReply(t, th, answered, 'sent');

		expect((await get(t, answered)).processingStatus).toBe('sent');
		for (const id of [olderDraft, olderAsking, olderInFlight]) {
			const message = await get(t, id);
			expect(message.processingStatus).toBe('archived');
			expect(message.archiveReason).toBe('answered_in_thread');
			expect(message.draftResponse).toBeUndefined();
			expect(message.pendingClarification).toBeUndefined();
			expect(message.answeredStash?.byInboundMessageIds).toEqual([answered]);
		}
		expect((await get(t, olderDraft)).answeredStash?.draftResponse).toBe(
			'Your order ships Monday.'
		);
		expect((await get(t, olderAsking)).answeredStash?.processingStatus).toBe(
			'awaiting_clarification'
		);
		expect((await get(t, olderEdited)).draftResponse).toBe('Edited by a teammate.');
		expect((await get(t, olderEdited)).processingStatus).toBe('draft_ready');
		expect((await get(t, newer)).processingStatus).toBe('draft_ready');

		// The generation that was in flight completes late: nothing is written back.
		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: olderInFlight,
			draftResponse: 'Your order ships Monday.',
			draftSubject: 'Re: Order',
			confidenceScore: 0.9,
		});
		const late = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: olderInFlight,
			input: { to: 'draft_ready', at: NOW + 1, draftResponse: 'Your order ships Monday.' },
		});
		expect(late.ok).toBe(false);
		const settled = await get(t, olderInFlight);
		expect(settled.processingStatus).toBe('archived');
		expect(settled.draftResponse).toBeUndefined();
	});

	it('leaves every older message as it was when the reply fails to send', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const olderDraft = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All orders ship Monday.',
			receivedAt: NOW,
		});

		await completeReply(t, th, answered, 'failed');

		expect((await get(t, answered)).processingStatus).toBe('failed');
		const older = await get(t, olderDraft);
		expect(older.processingStatus).toBe('draft_ready');
		expect(older.draftResponse).toBe('Your order ships Monday.');
	});

	it('reopens what it settled when the reply later bounces', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const olderDraft = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const olderAsking = await seedInbound(t, th, {
			processingStatus: 'awaiting_clarification',
			pendingClarification: { questions: [], askedAt: NOW - 2_500 },
			receivedAt: NOW - 2_000,
		});
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All orders ship Monday.',
			receivedAt: NOW,
		});

		const sendId = await completeReply(t, th, answered, 'sent');
		expect((await get(t, olderDraft)).processingStatus).toBe('archived');

		await laterBounce(t, sendId);

		const draft = await get(t, olderDraft);
		expect(draft.processingStatus).toBe('draft_ready');
		expect(draft.draftResponse).toBe('Your order ships Monday.');
		expect(draft.answeredStash).toBeUndefined();
		const asking = await get(t, olderAsking);
		expect(asking.processingStatus).toBe('awaiting_clarification');
		// Asked again as of the bounce: a new ask generation (see the clarification tests).
		expect(asking.pendingClarification?.askedAt).toBe(NOW + 60_000);
	});

	it('drops the stash after the retention window, leaving the message answered', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const olderDraft = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All orders ship Monday.',
			receivedAt: NOW,
		});
		await completeReply(t, th, answered, 'sent');

		await t.mutation(internal.inbox.answeredThread.purgeAnsweredStashes, {});
		expect((await get(t, olderDraft)).answeredStash).toBeDefined();

		await t.run(async (ctx) => {
			const message = (await ctx.db.get(olderDraft))!;
			await ctx.db.patch(olderDraft, {
				answeredStash: { ...message.answeredStash!, at: Date.now() - ANSWERED_RETENTION_MS - 1 },
			});
		});
		await t.mutation(internal.inbox.answeredThread.purgeAnsweredStashes, {});

		const settled = await get(t, olderDraft);
		expect(settled.answeredStash).toBeUndefined();
		expect(settled.processingStatus).toBe('archived');
	});

	it('keeps a message archived while another sent reply still answers it', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const older = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const firstAnswered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'Both orders ship Monday.',
			receivedAt: NOW,
		});
		const sendA = await completeReply(t, th, firstAnswered, 'sent');
		const secondAnswered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All three ship Monday.',
			receivedAt: NOW + 5_000,
		});
		const sendB = await completeReply(t, th, secondAnswered, 'sent');
		expect((await get(t, older)).answeredStash?.byInboundMessageIds).toEqual([
			firstAnswered,
			secondAnswered,
		]);

		await laterBounce(t, sendA); // the first reply never arrived, the second did
		const stillAnswered = await get(t, older);
		expect(stillAnswered.processingStatus).toBe('archived');
		expect(stillAnswered.answeredStash?.byInboundMessageIds).toEqual([secondAnswered]);

		await laterBounce(t, sendB); // now neither did
		const reopened = await get(t, older);
		expect(reopened.processingStatus).toBe('draft_ready');
		expect(reopened.draftResponse).toBe('Your order ships Monday.');
	});
});

describe('a clarification a bounce reopens', () => {
	it('is a new ask, so the archive’s queued notice cleanup cannot remove its notices', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const t = await pushHarness(modules, { 'user-a': 'admin' });
		const th = await seedThread(t);
		const askedAt = NOW - 1_000;
		const held = await seedInbound(t, th, {
			processingStatus: 'awaiting_clarification',
			receivedAt: NOW - 2_000,
			pendingClarification: {
				questions: [{ id: 'q1', slotType: 'text', text: 'Which order?' }],
				askedAt,
				remindedAt: NOW - 500,
				isRemindedForReaders: true,
			},
		});
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW,
		});
		const sendId = await completeReply(t, th, answered, 'sent');
		expect((await get(t, held)).processingStatus).toBe('archived');

		vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
		await laterBounce(t, sendId);
		const reopened = await get(t, held);
		expect(reopened.processingStatus).toBe('awaiting_clarification');
		expect(reopened.pendingClarification?.askedAt).toBe(NOW + 60_000);
		expect(reopened.pendingClarification?.isRemindedForReaders).toBeUndefined();
		expect(reopened.pendingClarification?.remindedAt).toBeUndefined();
		const notices = () =>
			t.run(async (ctx) =>
				(await ctx.db.query('inboxAssignmentNotices').collect()).filter(
					(n) => n.inboundMessageId === held
				)
			);
		expect(await notices()).toHaveLength(1);

		// The cleanup the archive queued, for the settled ask, runs only now.
		await t.mutation(internal.inbox.clarificationHoldSync.clearClarificationNotices, {
			inboundMessageId: held,
			askedAt,
			cursor: null,
		});

		expect(await notices()).toHaveLength(1);
	});
});

describe('a late draft for a message a newer reply answered', () => {
	it('is skipped as answered before the draft-gap fence, so nothing is held', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		// Still drafting when the newer reply went out: archived as answered.
		const inFlight = await seedInbound(t, th, {
			processingStatus: 'drafting',
			receivedAt: NOW - 3_000,
		});
		const answered = await seedInbound(t, th, { processingStatus: 'approved', receivedAt: NOW });
		await completeReply(t, th, answered, 'sent');
		expect((await get(t, inFlight)).processingStatus).toBe('archived');
		const fence = vi.mocked(clarificationAnswers.hasUnconsentedOpenQuestion);
		fence.mockClear();

		// The late draft has a gap no one agreed to: the fence would hold it.
		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: inFlight,
			draftResponse: 'Your order [[order number]] ships Monday.',
			draftSubject: 'Re: Order',
			confidenceScore: 0.9,
		});

		expect(fence).not.toHaveBeenCalled();
		const message = await get(t, inFlight);
		expect(message.processingStatus).toBe('archived');
		expect(message.archiveReason).toBe('answered_in_thread');
		expect(message.pendingClarification).toBeUndefined();
		expect(message.draftResponse).toBeUndefined();
		expect(message.isAutoSendBlocked).toBeUndefined();
		expect(message.answeredStash?.processingStatus).toBe('drafting');
	});
});

describe('a Team Inbox stash answered by several replies', () => {
	it('keeps the stash through the newest reply’s bounce window, not the first one’s', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const older = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const first = await seedInbound(t, th, { processingStatus: 'approved', receivedAt: NOW });
		const sendA = await completeReply(t, th, first, 'sent');
		// A was sent longer ago than the retention window.
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(older))!;
			await ctx.db.patch(older, {
				answeredStash: { ...message.answeredStash!, at: Date.now() - ANSWERED_RETENTION_MS - 1 },
			});
		});
		const second = await seedInbound(t, th, {
			processingStatus: 'approved',
			receivedAt: NOW + 5_000,
		});
		const sendB = await completeReply(t, th, second, 'sent'); // a distinct reply renews retention

		await laterBounce(t, sendA);
		await t.mutation(internal.inbox.answeredThread.purgeAnsweredStashes, {});
		expect((await get(t, older)).answeredStash?.byInboundMessageIds).toEqual([second]);

		await laterBounce(t, sendB);
		const reopened = await get(t, older);
		expect(reopened.processingStatus).toBe('draft_ready');
		expect(reopened.draftResponse).toBe('Your order ships Monday.');
	});

	it('stops tracking past the cap and keeps such a message archived for good', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		const older = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const first = await seedInbound(t, th, { processingStatus: 'approved', receivedAt: NOW });
		const sendA = await completeReply(t, th, first, 'sent');
		// As many other sent replies as the cap allows.
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(older))!;
			const others: Id<'inboundMessages'>[] = [];
			for (let i = 1; i < MAX_TRACKED_ANSWERS; i++) {
				others.push(
					await ctx.db.insert('inboundMessages', {
						to: 'support@example.com',
						from: 'customer@example.com',
						subject: 'Order',
						textBody: 'More',
						messageId: `<other-${i}@example.com>`,
						processingStatus: 'sent',
						receivedAt: NOW + i,
					})
				);
			}
			await ctx.db.patch(older, {
				answeredStash: { ...message.answeredStash!, byInboundMessageIds: [first, ...others] },
			});
		});

		const second = await seedInbound(t, th, {
			processingStatus: 'approved',
			receivedAt: NOW + 5_000,
		});
		await completeReply(t, th, second, 'sent');
		const stash = (await get(t, older)).answeredStash!;
		expect(stash.byInboundMessageIds).toHaveLength(MAX_TRACKED_ANSWERS);
		expect(stash.isUntracked).toBe(true);

		await laterBounce(t, sendA);
		expect((await get(t, older)).processingStatus).toBe('archived');
	});
});

describe('the response clock of a reopened message', () => {
	const NEXT_RESPONSE_MS = 120 * 60_000;
	const BOUNCE_AT = NOW + 60_000;

	// One clock for the whole story: the reply goes out at NOW, the bounce
	// comes at BOUNCE_AT (timeline rows are stamped with Date.now()).
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
	});
	const bounce = async (t: T, sendId: Id<'transactionalSends'>, at = BOUNCE_AT) => {
		vi.mocked(Date.now).mockReturnValue(at);
		await laterBounce(t, sendId);
	};

	/** Response targets on (calendar hours), and the thread's clock running from the older mail. */
	async function withTargets(t: T, th: Thread): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert('inboxSlaPolicies', {
				isEnabled: true,
				firstResponseMinutes: 60,
				nextResponseMinutes: 120,
				hoursMode: 'calendar',
				timeZone: 'UTC',
				businessHours: [],
				holidays: [],
				updatedAt: NOW,
			});
			await ctx.db.patch(th.threadId, {
				responseDueAt: NOW + 3_600_000,
				responseDueKind: 'first',
				responseClockStartedAt: NOW - 3_000,
			});
		});
	}

	const thread = (t: T, th: Thread) => t.run(async (ctx) => (await ctx.db.get(th.threadId))!);

	it.each(['draft_ready', 'awaiting_clarification'] as const)(
		'starts a next-response clock from the bounce when it reopens %s',
		async (status) => {
			const t = await pushHarness(modules, {});
			const th = await seedThread(t);
			await withTargets(t, th);
			const older = await seedInbound(t, th, {
				processingStatus: status,
				receivedAt: NOW - 3_000,
				...(status === 'draft_ready'
					? { draftResponse: 'Your order ships Monday.' }
					: { pendingClarification: { questions: [], askedAt: NOW - 3_000 } }),
			});
			const answered = await seedInbound(t, th, {
				processingStatus: 'approved',
				draftResponse: 'All orders ship Monday.',
				receivedAt: NOW,
			});
			const sendId = await completeReply(t, th, answered, 'sent');
			expect((await thread(t, th)).responseDueAt).toBeUndefined(); // answered: clock closed

			await bounce(t, sendId);

			expect((await get(t, older)).processingStatus).toBe(status);
			const reopened = await thread(t, th);
			expect(reopened.responseDueKind).toBe('next');
			expect(reopened.responseClockStartedAt).toBe(BOUNCE_AT);
			expect(reopened.responseDueAt).toBe(BOUNCE_AT + NEXT_RESPONSE_MS);
		}
	);

	it('leaves a clock that is already running as it is', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		const answered = await seedInbound(t, th, { processingStatus: 'approved', receivedAt: NOW });
		const sendId = await completeReply(t, th, answered, 'sent');
		// The customer wrote again meanwhile: a clock runs for that.
		const running = { responseDueAt: NOW + 999_000, responseClockStartedAt: NOW + 30_000 };
		await t.run(async (ctx) =>
			ctx.db.patch(th.threadId, { ...running, responseDueKind: 'next' as const })
		);

		await bounce(t, sendId);

		expect(await thread(t, th)).toMatchObject(running);
	});

	/** The reply to a newer message settled `older`; its bounce reopens it. Returns the send. */
	async function answeredThenBounced(t: T, th: Thread, between?: () => Promise<void>) {
		const older = await seedInbound(t, th, {
			processingStatus: 'draft_ready',
			draftResponse: 'Your order ships Monday.',
			receivedAt: NOW - 3_000,
		});
		await between?.();
		const answered = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'All orders ship Monday.',
			receivedAt: NOW,
		});
		const sendId = await completeReply(t, th, answered, 'sent');
		return { older, answered, sendId };
	}

	it('keeps the reopened clock when a newer message turns out to need no reply', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		expect((await thread(t, th)).responseDueAt).toBe(BOUNCE_AT + NEXT_RESPONSE_MS);

		// A newer mail is classified as an FYI: the cleanup scan passes the
		// answered (`sent`) message on its way down, and must not stop there.
		const newer = await seedInbound(t, th, {
			processingStatus: 'classifying',
			receivedAt: BOUNCE_AT + 30_000,
		});
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: newer,
			input: { to: 'informational', at: BOUNCE_AT + 30_000 },
		});

		expect(outcome.ok).toBe(true);
		expect((await get(t, older)).processingStatus).toBe('draft_ready');
		expect((await thread(t, th)).responseDueAt).toBe(BOUNCE_AT + NEXT_RESPONSE_MS);
	});

	it('starts a clock for reopened work when targets are switched on after the bounce', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const policy = await t.run(async (ctx) => (await ctx.db.query('inboxSlaPolicies').first())!);
		await t.run(async (ctx) => ctx.db.patch(policy._id, { isEnabled: false, updatedAt: NOW }));
		const { older, answered, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		expect((await get(t, older)).processingStatus).toBe('draft_ready');
		expect((await get(t, answered)).processingStatus).toBe('sent'); // the newest message
		expect((await thread(t, th)).responseDueAt).toBeUndefined();

		const generation = BOUNCE_AT + 30_000;
		vi.mocked(Date.now).mockReturnValue(generation);
		await t.run(async (ctx) =>
			ctx.db.patch(policy._id, { isEnabled: true, updatedAt: generation })
		);
		await t.mutation(internal.inbox.sla.apply.applyPage, { generation, cursor: null });

		expect((await thread(t, th)).responseDueAt).toBe(generation + NEXT_RESPONSE_MS);
	});

	/** Save the response-target policy (targets on) and run its switch-on sweep at `at`. */
	async function savePolicy(t: T, at: number, isEnabled = true): Promise<void> {
		vi.mocked(Date.now).mockReturnValue(at);
		const policy = await t.run(async (ctx) => (await ctx.db.query('inboxSlaPolicies').first())!);
		await t.run(async (ctx) => ctx.db.patch(policy._id, { isEnabled, updatedAt: at }));
		await t.mutation(internal.inbox.sla.apply.applyPage, { generation: at, cursor: null });
	}

	/** `count` newer FYI mails, which need no reply. */
	async function newerUpdates(t: T, th: Thread, count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await seedInbound(t, th, { processingStatus: 'informational', receivedAt: NOW + 1_000 + i });
		}
	}

	it('keeps the reopened clock behind more than 200 newer messages', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th, () => newerUpdates(t, th, 200));
		await bounce(t, sendId);
		expect((await get(t, older)).answerBouncedAt).toBe(BOUNCE_AT);
		expect((await thread(t, th)).responseDueAt).toBe(BOUNCE_AT + NEXT_RESPONSE_MS);

		const newer = await seedInbound(t, th, {
			processingStatus: 'classifying',
			receivedAt: BOUNCE_AT + 30_000,
		});
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: newer,
			input: { to: 'informational', at: BOUNCE_AT + 30_000 },
		});

		expect((await thread(t, th)).responseDueAt).toBe(BOUNCE_AT + NEXT_RESPONSE_MS);
	});

	it('finds reopened work behind more than 200 newer messages when targets are switched on', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const policy = await t.run(async (ctx) => (await ctx.db.query('inboxSlaPolicies').first())!);
		await t.run(async (ctx) => ctx.db.patch(policy._id, { isEnabled: false, updatedAt: NOW }));
		const { sendId } = await answeredThenBounced(t, th, () => newerUpdates(t, th, 200));
		await bounce(t, sendId);
		expect((await thread(t, th)).responseDueAt).toBeUndefined();

		const generation = BOUNCE_AT + 30_000;
		await savePolicy(t, generation);

		expect((await thread(t, th)).responseDueAt).toBe(generation + NEXT_RESPONSE_MS);
	});

	it('ends the obligation when the reopened message is archived, so a takeover owes nothing', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		expect((await get(t, older)).answerBouncedAt).toBe(BOUNCE_AT);

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: older,
			input: { to: 'archived', at: BOUNCE_AT + 1, reason: 'handling_rule_archive' },
		});
		expect((await get(t, older)).answerBouncedAt).toBeUndefined();
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: older,
			input: { to: 'draft_ready', at: BOUNCE_AT + 2, manualTakeover: true },
		});
		expect((await thread(t, th)).responseDueAt).toBeUndefined();

		await savePolicy(t, BOUNCE_AT + 30_000);

		// Archiving ended the obligation: this is a person's own reply now.
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
	});

	it('ends the obligation when a later reply goes out, keeping a person’s draft', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		await t.run(async (ctx) =>
			appendDraftRevision(ctx, (await ctx.db.get(older))!, {
				text: 'Human draft',
				savedBy: 'review-user',
			})
		);
		const newer = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'New response',
			receivedAt: BOUNCE_AT + 10_000,
		});
		vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 20_000);
		await completeReply(t, th, newer, 'sent');

		const kept = await get(t, older);
		expect(kept.processingStatus).toBe('draft_ready');
		expect(kept.draftResponse).toBe('Human draft');
		expect(kept.answerBouncedAt).toBeUndefined();
		expect((await thread(t, th)).responseDueAt).toBeUndefined();

		await savePolicy(t, BOUNCE_AT + 30_000);

		expect((await thread(t, th)).responseDueAt).toBeUndefined();
	});

	it.each(['sms', 'team_reply'] as const)(
		'ends the obligation when a %s reply goes out, however much timeline follows',
		async (channel) => {
			const t = await pushHarness(modules, {});
			const th = await seedThread(t);
			await withTargets(t, th);
			const { older, answered, sendId } = await answeredThenBounced(t, th);
			await bounce(t, sendId);
			expect((await get(t, older)).answerBouncedAt).toBe(BOUNCE_AT);

			vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 10_000);
			if (channel === 'sms') {
				await t.mutation(internal.unifiedMessages.recordOutbound, {
					threadId: th.threadId,
					contactId: th.contactId,
					channel: 'sms',
					content: 'Your answer',
					status: 'sent',
				});
			} else {
				const followUpId = await t.run(async (ctx) =>
					ctx.db.insert('inboxFollowUps', {
						threadId: th.threadId,
						inReplyToMessageId: answered,
						subject: 'Re: Order',
						body: 'Your answer',
						status: 'sending',
						createdBy: 'review-user',
						createdAt: BOUNCE_AT + 10_000,
						sendAt: BOUNCE_AT + 10_000,
					})
				);
				await t.mutation(internal.inbox.followUps.completeSend, {
					followUpId,
					outcome: { kind: 'sent', at: BOUNCE_AT + 10_000, providerMessageId: 'followup-1' },
				});
			}
			expect((await get(t, older)).answerBouncedAt).toBeUndefined();
			expect((await thread(t, th)).responseDueAt).toBeUndefined();

			// Fifty FYIs push that reply out of the timeline window.
			for (let i = 0; i < 50; i++) {
				vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 20_000 + i);
				await seedInbound(t, th, {
					processingStatus: 'informational',
					receivedAt: BOUNCE_AT + 20_000 + i,
				});
				await t.run(async (ctx) =>
					recordInboundMirror(ctx, {
						threadId: th.threadId,
						contactId: th.contactId,
						channel: 'email',
						content: 'FYI',
						externalMessageId: `fyi-${i}`,
					})
				);
			}
			await savePolicy(t, BOUNCE_AT + 30_000);

			expect((await thread(t, th)).responseDueAt).toBeUndefined();
			expect(await t.run(async (ctx) => isReplyOwed(ctx, th.threadId))).toBe(false);
		}
	);

	it('judges a marker some path left behind against every reply, not the timeline window', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 10_000);
		await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId: th.threadId,
			contactId: th.contactId,
			channel: 'sms',
			content: 'Your answer',
			status: 'sent',
		});
		// As if a path had missed clearing it: only the reply record can tell.
		await t.run(async (ctx) => ctx.db.patch(older, { answerBouncedAt: BOUNCE_AT }));
		for (let i = 0; i < 50; i++) {
			vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 20_000 + i);
			await t.run(async (ctx) =>
				recordInboundMirror(ctx, {
					threadId: th.threadId,
					contactId: th.contactId,
					channel: 'email',
					content: 'FYI',
					externalMessageId: `fyi-${i}`,
				})
			);
		}

		expect((await thread(t, th)).lastReplySentAt).toBe(BOUNCE_AT + 10_000);
		expect(await t.run(async (ctx) => isReplyOwed(ctx, th.threadId))).toBe(false);
	});

	it('ends the obligation when a reply to an older message goes out, keeping a person’s draft', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		await t.run(async (ctx) =>
			appendDraftRevision(ctx, (await ctx.db.get(older))!, {
				text: 'Human draft',
				savedBy: 'review-user',
			})
		);
		const earlier = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'New response',
			receivedAt: NOW - 10_000,
		});
		vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 20_000);
		await completeReply(t, th, earlier, 'sent');

		const kept = await get(t, older);
		expect(kept.draftResponse).toBe('Human draft');
		expect(kept.answerBouncedAt).toBeUndefined();
		expect(await t.run(async (ctx) => isReplyOwed(ctx, th.threadId))).toBe(false);
		await savePolicy(t, BOUNCE_AT + 30_000);
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
	});

	/** An approved earlier message whose Send is still in flight, archived meanwhile, then delivered. */
	async function deliveredAfterArchive(t: T, th: Thread) {
		const earlier = await seedInbound(t, th, {
			processingStatus: 'approved',
			draftResponse: 'Earlier answer',
			receivedAt: NOW - 10_000,
		});
		const earlierSend = await t.run(async (ctx) =>
			ctx.db.insert('transactionalSends', {
				kind: 'agent_reply' as const,
				email: 'customer@example.com',
				status: 'queued',
				queuedAt: NOW,
				inboundMessageId: earlier,
				contactId: th.contactId,
				subject: 'Re: Order',
			})
		);
		const { older, sendId } = await answeredThenBounced(t, th);
		await bounce(t, sendId);
		expect((await get(t, older)).answerBouncedAt).toBe(BOUNCE_AT);
		// The sender gets blocked while the earlier reply is still in flight.
		const archived = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: earlier,
			input: { to: 'archived', at: BOUNCE_AT + 1, reason: 'sender_blocked' },
		});
		expect(archived.ok).toBe(true);
		const deliver = async () => {
			vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 10_000);
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'transactional', id: earlierSend },
				transition: { to: 'sent', at: BOUNCE_AT + 10_000, providerMessageId: 'earlier-reply' },
			});
		};
		return { earlier, older, deliver };
	}

	it('reports a delivered reply to the thread even when its message was archived in flight', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { earlier, older, deliver } = await deliveredAfterArchive(t, th);

		await deliver();

		expect((await get(t, earlier)).processingStatus).toBe('archived'); // left as it was
		expect((await get(t, older)).answerBouncedAt).toBeUndefined();
		expect((await thread(t, th)).lastReplySentAt).toBe(BOUNCE_AT + 10_000);
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
		for (let i = 0; i < 50; i++) {
			vi.mocked(Date.now).mockReturnValue(BOUNCE_AT + 20_000 + i);
			await seedInbound(t, th, {
				processingStatus: 'informational',
				receivedAt: BOUNCE_AT + 20_000 + i,
			});
			await t.run(async (ctx) =>
				recordInboundMirror(ctx, {
					threadId: th.threadId,
					contactId: th.contactId,
					channel: 'email',
					content: 'FYI',
					externalMessageId: `fyi-${i}`,
				})
			);
		}
		expect(await t.run(async (ctx) => isReplyOwed(ctx, th.threadId))).toBe(false);
		await savePolicy(t, BOUNCE_AT + 30_000);
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
	});

	it('counts that reply once, however often its delivery is reported', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		const { deliver } = await deliveredAfterArchive(t, th);
		await deliver();
		const once = await thread(t, th);

		await deliver(); // the same delivery report again

		const twice = await thread(t, th);
		expect(twice.slaMetCount ?? 0).toBe(once.slaMetCount ?? 0);
		expect(twice.slaMissedCount ?? 0).toBe(once.slaMissedCount ?? 0);
		expect(twice.lastReplySentAt).toBe(once.lastReplySentAt);
	});

	it('starts nothing for a person taking over an archived message, as before', async () => {
		const t = await pushHarness(modules, {});
		const th = await seedThread(t);
		await withTargets(t, th);
		await t.run(async (ctx) =>
			ctx.db.patch(th.threadId, {
				responseDueAt: undefined,
				responseDueKind: undefined,
				responseClockStartedAt: undefined,
			})
		);
		const archived = await seedInbound(t, th, {
			processingStatus: 'archived',
			archiveReason: 'classifier_spam',
			receivedAt: NOW - 3_000,
		});

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: archived,
			input: { to: 'draft_ready', at: NOW, manualTakeover: true },
		});

		expect(outcome.ok).toBe(true);
		expect((await thread(t, th)).responseDueAt).toBeUndefined();
	});
});

describe('the stash purge under real transaction limits', () => {
	it('works through large messages in bounded runs, each one making progress', async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const th = await seedThread(t);
		const answered = await seedInbound(t, th, { processingStatus: 'sent', receivedAt: NOW });
		const old = Date.now() - ANSWERED_RETENTION_MS - 1;
		const ids: Id<'inboundMessages'>[] = [];
		for (let i = 0; i < 25; i++) {
			const id = await seedInbound(t, th, {
				processingStatus: 'archived',
				archiveReason: 'answered_in_thread',
				textBody: 'x'.repeat(700 * 1024),
				receivedAt: NOW - 10_000 - i,
				answeredStash: {
					byInboundMessageIds: [answered],
					at: old,
					processingStatus: 'draft_ready',
					draftResponse: 'Your order ships Monday.',
				},
			});
			// Each row is a valid document on its own (under 1 MiB).
			expect(JSON.stringify(await get(t, id)).length).toBeLessThan(1024 * 1024);
			ids.push(id);
		}

		for (let run = 0; run < 25; run++) {
			const { purged } = await t.mutation(internal.inbox.answeredThread.purgeAnsweredStashes, {});
			expect(purged).toBeGreaterThan(0);
			const rows = await Promise.all(ids.map((id) => get(t, id)));
			if (rows.every((row) => row.answeredStash === undefined)) break;
		}
		const rows = await Promise.all(ids.map((id) => get(t, id)));
		expect(
			rows.every((row) => row.answeredStash === undefined && row.processingStatus === 'archived')
		).toBe(true);
	});
});
