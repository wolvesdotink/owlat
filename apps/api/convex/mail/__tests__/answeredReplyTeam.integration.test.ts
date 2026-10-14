/**
 * #1346 for the Team Inbox: once the agent reply to a newer message of a
 * thread is sent, the older messages the agent was still drafting or asking
 * about are answered too. Their AI draft and questions go (archived,
 * `answered_in_thread`, kept in a stash) and a late generation cannot write
 * them back; a later bounce of that reply reopens them, and the retention
 * window drops the stash. A person's edited draft, a newer message, and every
 * message of a reply that failed to send stay as they were.
 */

import type { TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import type schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { createTestContact, flushScheduled } from '../../__tests__/factories';
import { pushHarness } from '../../push/__tests__/pushFixtures';
import { modules } from './helpers.testlib';
import { ANSWERED_RETENTION_MS } from '../answeredReply';

const NOW = 1_700_000_000_000;
const workId = 'test-work-id' as WorkId;

afterEach(async () => {
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
			expect(message.answeredStash?.byInboundMessageId).toBe(answered);
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
		expect(asking.pendingClarification?.askedAt).toBe(NOW - 2_500);
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
});
