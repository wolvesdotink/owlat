/**
 * Security regression test for the `categorize` handling rule at classify time.
 *
 * A categorize rule may only ever RESTRICT, never widen, auto-send. The route
 * step's fail-closed complaint/urgent hard-block keys off the persisted
 * classification, so a categorize rule must NEVER be able to move a message OUT
 * of the protected `complaint` category (or off `urgent` priority) — otherwise
 * attacker-craftable inbound content matching a benign categorize rule would
 * strip a complaint's guaranteed human review. These tests exercise
 * `classifyStep.execute` with the LLM seam mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	getLLMProvider: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	getLLMProvider: mocks.getLLMProvider,
}));

import { classifyStep } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_guard_1' as Id<'inboundMessages'>;
const sampleInput = { inboundMessageId: messageId, context: '[CONTEXT]' };

/** A categorize rule that would force any matching message to `support`. */
function categorizeToSupportRule() {
	return {
		_id: 'rule_cat' as Id<'handlingRules'>,
		_creationTime: 0,
		naturalLanguage: 'categorize billing mail as support',
		status: 'active' as const,
		isEnabled: true,
		action: 'categorize' as const,
		category: 'support',
		matcher: { conditions: [{ field: 'from', op: 'contains', value: 'billing@' }] },
		createdAt: 0,
		updatedAt: 0,
	};
}

/**
 * execute ctx: the classifier returns `classification`; listActiveInternal
 * returns `rules`; getMessage returns a message from the given sender.
 */
function makeCtx(classification: Record<string, unknown>, rules: unknown[], from: string) {
	mocks.runLlmObject.mockResolvedValue({
		object: classification,
		tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		modelUsed: 'mock-model',
	});
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('listActiveInternal')) return rules;
			if (name.includes('getMessage'))
				return { from, subject: 'Refund now', textBody: 'this is unacceptable', htmlBody: '' };
			throw new Error(`unexpected runQuery: ${name}`);
		},
	} as unknown as Parameters<typeof classifyStep.execute>[0];
}

const complaint = {
	category: 'complaint',
	priority: 'normal',
	sentiment: 'negative',
	intent: 'complaint',
	confidence: 0.9,
};

describe('classifyStep.execute — categorize is restrict-only vs complaint/urgent', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does NOT let a categorize rule move a complaint out of complaint', async () => {
		const ctx = makeCtx(complaint, [categorizeToSupportRule()], 'billing@vendor.com');
		const { output } = await classifyStep.execute(ctx, sampleInput);
		// The complaint hard-block must survive: the forced category is dropped.
		expect(output.category).toBe('complaint');
	});

	it('does NOT let a categorize rule move an urgent message off its category', async () => {
		const urgent = { ...complaint, category: 'support', priority: 'urgent' };
		// Rule would force to `sales` — but the message is urgent, so it is dropped.
		const rule = { ...categorizeToSupportRule(), category: 'sales' };
		const ctx = makeCtx(urgent, [rule], 'billing@vendor.com');
		const { output } = await classifyStep.execute(ctx, sampleInput);
		expect(output.category).toBe('support');
	});

	it('still applies categorize to an unprotected (non-complaint, non-urgent) message', async () => {
		const ordinary = { ...complaint, category: 'other', priority: 'normal', intent: 'question' };
		const ctx = makeCtx(ordinary, [categorizeToSupportRule()], 'billing@vendor.com');
		const { output } = await classifyStep.execute(ctx, sampleInput);
		expect(output.category).toBe('support');
	});
});
