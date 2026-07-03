/**
 * Post-send OUTCOME feedback (graduated-autonomy learning).
 *
 * The self-tuning loop historically learned only from the human review queue.
 * These tests cover the second signal source — real-world outcomes on AUTO-sent
 * messages — so the loop stays calibrated as auto-send volume grows:
 *
 *   - a negative-sentiment reply to an auto-sent message records NEGATIVE
 *     autonomy feedback for that message's category;
 *   - a bounce / complaint on an auto-sent agent reply records NEGATIVE;
 *   - an unedited answered-clarification send records POSITIVE;
 *   - a NEUTRAL reply is never mislabeled (conservative: false-negatives
 *     preferred), and a classification failure records nothing (fail-soft);
 *   - a reply to a HUMAN-reviewed send is never attributed a negative outcome;
 *   - the recorded rows are exactly the input `autonomy.adjustThresholds`
 *     consumes (getRecentFeedbackInternal).
 *
 * The LLM dispatch seam + provider factory are mocked — no live model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	getLLMProvider: vi.fn(() => 'mock-model'),
}));

vi.mock('../lib/llm/dispatch', () => ({
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../lib/llmProvider', () => ({
	getLLMProvider: mocks.getLLMProvider,
}));

import { convexTest } from 'convex-test';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutonomyRule,
	createTestInboundMessage,
	createTestConversationThread,
} from './factories';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

function objectResult(object: unknown) {
	return { object, tokenUsage: undefined, modelUsed: 'mock-model' };
}

beforeEach(() => {
	mocks.runLlmObject.mockReset();
	mocks.getLLMProvider.mockReset();
	mocks.getLLMProvider.mockReturnValue('mock-model');
});

/** Insert an auto-approved message that reached `sent` on a fresh thread. */
async function seedAutoSentOnThread(
	t: ReturnType<typeof convexTest>,
	opts: { category?: string; confidence?: number; decision?: 'auto_approve' | 'human_review' } = {}
): Promise<{ threadId: Id<'conversationThreads'>; originalId: Id<'inboundMessages'> }> {
	return await t.run(async (ctx) => {
		// Insert only schema-valid columns: the shared factory also emits
		// `channel`/`updatedAt`, which are not on the conversationThreads table
		// and a raw ctx.db.insert would reject.
		const {
			channel: _channel,
			updatedAt: _updatedAt,
			...threadDoc
		} = createTestConversationThread({ contactId: undefined });
		const threadId = await ctx.db.insert('conversationThreads', threadDoc as never);
		const originalId = await ctx.db.insert('inboundMessages', {
			...createTestInboundMessage({
				threadId,
				contactId: undefined,
				processingStatus: 'sent',
				receivedAt: 1_000,
				confidenceScore: opts.confidence ?? 0.9,
				classification: {
					category: opts.category ?? 'support',
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: opts.confidence ?? 0.9,
				},
				agentDecision: {
					decision: opts.decision ?? 'auto_approve',
					reason: 'confident',
					confidence: opts.confidence ?? 0.9,
				},
			}),
		} as never);
		return { threadId, originalId };
	});
}

async function feedbackRows(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => ctx.db.query('autonomyFeedback').collect());
}

describe('autonomyOutcome.recordOutcomeFeedback', () => {
	it('records a bounce as NEGATIVE (rejected) feedback for the original category', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'autonomyRules',
				createTestAutonomyRule({ category: 'billing' }) as never
			);
		});
		const { originalId } = await seedAutoSentOnThread(t, { category: 'billing', confidence: 0.8 });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'bounce',
		});

		const rows = await feedbackRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: 'billing',
			action: 'rejected',
			source: 'outcome',
			outcomeSignal: 'bounce',
			agentConfidence: 0.8,
			inboundMessageId: originalId,
		});
	});

	it('records a complaint as NEGATIVE (rejected) feedback', async () => {
		const t = convexTest(schema, modules);
		const { originalId } = await seedAutoSentOnThread(t, { category: 'support' });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'complaint',
		});

		const rows = await feedbackRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: 'rejected',
			outcomeSignal: 'complaint',
			source: 'outcome',
		});
	});

	it('records an unedited answered-clarification send as POSITIVE (approved) feedback', async () => {
		const t = convexTest(schema, modules);
		const { originalId } = await seedAutoSentOnThread(t, { category: 'sales' });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'clarification_unedited_send',
		});

		const rows = await feedbackRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: 'sales',
			action: 'approved',
			source: 'outcome',
			outcomeSignal: 'clarification_unedited_send',
		});
	});

	it('is a no-op when the original message is gone', async () => {
		const t = convexTest(schema, modules);
		const ghostId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'inboundMessages',
				createTestInboundMessage({ threadId: undefined, contactId: undefined }) as never
			);
			await ctx.db.delete(id);
			return id;
		});

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: ghostId,
			signal: 'bounce',
		});

		expect(await feedbackRows(t)).toHaveLength(0);
	});
});

describe('autonomyOutcome.getReplyOutcomeContext', () => {
	it('links a reply to a prior AUTO-sent message on the same thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId, originalId } = await seedAutoSentOnThread(t);

		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({
					threadId,
					contactId: undefined,
					receivedAt: 2_000,
					processingStatus: 'received',
				}),
			} as never)
		);

		const ctx = await t.query(internal.autonomyOutcome.getReplyOutcomeContext, {
			replyMessageId: replyId,
		});
		expect(ctx).toEqual({ wasAutoSent: true, originalMessageId: originalId });
	});

	it('does NOT link a reply to a HUMAN-reviewed send', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAutoSentOnThread(t, { decision: 'human_review' });

		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({
					threadId,
					contactId: undefined,
					receivedAt: 2_000,
					processingStatus: 'received',
				}),
			} as never)
		);

		expect(
			await t.query(internal.autonomyOutcome.getReplyOutcomeContext, { replyMessageId: replyId })
		).toBeNull();
	});
});

describe('agent.outcomeFeedback.classifyReplyOutcome', () => {
	it('records NEGATIVE feedback for a clearly negative reply to an auto-sent message', async () => {
		const t = convexTest(schema, modules);
		const { threadId, originalId } = await seedAutoSentOnThread(t, { category: 'support' });
		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({ threadId, contactId: undefined, receivedAt: 2_000 }),
			} as never)
		);
		mocks.runLlmObject.mockResolvedValue(objectResult({ sentiment: 'negative' }));

		await t.action(internal.agent.outcomeFeedback.classifyReplyOutcome, {
			replyMessageId: replyId,
			replyText: 'This is completely wrong and unhelpful. Absolutely furious.',
		});

		const rows = await feedbackRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: 'support',
			action: 'rejected',
			source: 'outcome',
			outcomeSignal: 'reply_negative',
			inboundMessageId: originalId,
		});
	});

	it('does NOT record anything for a NEUTRAL reply (no mislabeling)', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAutoSentOnThread(t);
		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({ threadId, contactId: undefined, receivedAt: 2_000 }),
			} as never)
		);
		mocks.runLlmObject.mockResolvedValue(objectResult({ sentiment: 'neutral' }));

		await t.action(internal.agent.outcomeFeedback.classifyReplyOutcome, {
			replyMessageId: replyId,
			replyText: 'Thanks, and one more quick question about the timeline?',
		});

		expect(await feedbackRows(t)).toHaveLength(0);
	});

	it('fails soft: a classification error records nothing and does not throw', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAutoSentOnThread(t);
		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({ threadId, contactId: undefined, receivedAt: 2_000 }),
			} as never)
		);
		mocks.runLlmObject.mockRejectedValue(new Error('model down'));

		await expect(
			t.action(internal.agent.outcomeFeedback.classifyReplyOutcome, {
				replyMessageId: replyId,
				replyText: 'anything',
			})
		).resolves.toBeNull();

		expect(await feedbackRows(t)).toHaveLength(0);
	});

	it('does NOT record when the reply is to a human-reviewed send, even if negative', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAutoSentOnThread(t, { decision: 'human_review' });
		const replyId = await t.run(async (ctx) =>
			ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({ threadId, contactId: undefined, receivedAt: 2_000 }),
			} as never)
		);
		mocks.runLlmObject.mockResolvedValue(objectResult({ sentiment: 'negative' }));

		await t.action(internal.agent.outcomeFeedback.classifyReplyOutcome, {
			replyMessageId: replyId,
			replyText: 'Furious!',
		});

		expect(await feedbackRows(t)).toHaveLength(0);
		// The classifier must not even be consulted once auto-send is ruled out.
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});
});

describe('outcome feedback flows into adjustThresholds input', () => {
	it('surfaces outcome rows via getRecentFeedbackInternal (the cron input)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'autonomyRules',
				createTestAutonomyRule({ category: 'support' }) as never
			);
		});
		const { originalId } = await seedAutoSentOnThread(t, { category: 'support' });

		// Two negative outcomes (bounce + complaint) captured without any human review.
		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'bounce',
		});
		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'complaint',
		});

		const feedback = await t.query(internal.autonomy.getRecentFeedbackInternal, {
			category: 'support',
		});
		expect(feedback).toHaveLength(2);
		expect(feedback.every((f) => f.action === 'rejected' && f.source === 'outcome')).toBe(true);
	});
});
