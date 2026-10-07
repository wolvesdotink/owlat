/**
 * Shared scaffolding for the thread brief Convex tests: the convex-test module
 * map and seeds for a Postbox thread and a Team Inbox thread. The double-dot
 * name keeps Convex from bundling it (see mail/__tests__/helpers.testlib.ts).
 */

import type { TestConvex } from 'convex-test';
import type { Id } from '../../../_generated/dataModel';
import type schema from '../../../schema';
import { seedFolder, seedMailbox, seedMessage, type MailboxSeed } from '../../__tests__/helpers.testlib';
import { enableFeatures } from '../../../__tests__/factories';
import type { ReduceItem, ReduceResult } from '../reduceInput';

const allModules = import.meta.glob('../../../**/*.*s');

export const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('/agent/') &&
			!path.includes('sesActions') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

export type Test = TestConvex<typeof schema>;

/** A personal (or shared) mailbox with one inbound message in one thread. */
export async function seedMailThread(
	t: Test,
	seed: MailboxSeed & { text?: string } = {}
): Promise<{
	mailboxId: Id<'mailboxes'>;
	messageId: Id<'mailMessages'>;
	threadId: Id<'mailThreads'>;
}> {
	const mailboxId = await seedMailbox(t, { address: 'me@owlat.test', ...seed });
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		fromAddress: 'jonas@example.com',
		textBodyInline: seed.text ?? 'Could you send the signed contract by Friday?',
		receivedAt: Date.UTC(2026, 9, 7, 9, 0),
	});
	const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
	return { mailboxId, messageId, threadId };
}

/** A Team Inbox conversation with one inbound message. */
export async function seedTeamThread(
	t: Test,
	opts: { assignedTo?: string } = {}
): Promise<{ threadId: Id<'conversationThreads'>; inboundId: Id<'inboundMessages'> }> {
	await enableFeatures(t, ['inbox']);
	return t.run(async (ctx) => {
		const now = Date.UTC(2026, 9, 7, 9, 0);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Order 42',
			normalizedSubject: 'order 42',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			...(opts.assignedTo ? { assignedTo: opts.assignedTo } : {}),
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const inboundId = await ctx.db.insert('inboundMessages', {
			messageId: '<order-42@example.com>',
			from: 'customer@example.com',
			to: 'support@owlat.test',
			subject: 'Order 42',
			textBody: 'Where is my order? Please refund it by Monday.',
			processingStatus: 'received',
			receivedAt: now,
			threadId,
		});
		return { threadId, inboundId };
	});
}

export function reduceItem(overrides: Partial<ReduceItem> = {}): ReduceItem {
	return {
		intent: 'request',
		facets: ['file', 'signature'],
		consequences: ['signature'],
		assertion: 'Send the signed contract',
		display: { en: 'Send the signed contract', de: 'Schick den unterschriebenen Vertrag' },
		requester: { email: 'jonas@example.com', isUs: false },
		responsible: { email: 'me@owlat.test', isUs: true },
		due: { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false },
		evidence: [{ segmentId: 's0', start: 0, end: 20, quote: 'send the signed contract' }],
		verify: 'passed',
		isReviewNeeded: false,
		...overrides,
	};
}

export function reduceResult(overrides: Partial<ReduceResult> = {}): ReduceResult {
	return {
		items: [reduceItem()],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		latest: {
			en: [
				{
					text: 'Jonas wants the signed contract by Friday.',
					evidence: [{ segmentId: 's0', start: 0, end: 20, quote: 'send the signed contract' }],
					isReviewNeeded: false,
				},
			],
			de: [
				{
					text: 'Jonas will den Vertrag bis Freitag.',
					evidence: [{ segmentId: 's0', start: 0, end: 20, quote: 'send the signed contract' }],
					isReviewNeeded: false,
				},
			],
		},
		facts: [],
		dropped: { grounding: 0, verify: 0 },
		...overrides,
	};
}
