/**
 * Every billed call an agent step makes lands in the usage ledger once (#1259):
 * the security-scan guard windows, the quarantined extraction, classify and
 * each clarify call. A failed call records the usage it carries
 * (`partialUsageOf`); one that carries none records nothing. The draft step is
 * covered in `draft/__tests__/draftSpend.test.ts`.
 *
 * The LLM dispatch seam and the provider factory are mocked; the spend helper is
 * real, so a ledger row is a call to the `analytics/llmUsage:record` mutation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx, type StepCtxRoutes } from './stepCtx';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	runLlmText: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../lib/llm/dispatch', () => ({
	runLlmObject: mocks.runLlmObject,
	runLlmText: mocks.runLlmText,
}));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
}));

import { securityScanStep } from '../security_scan';
import { runQuarantinedExtraction } from '../context_retrieval/quarantine';
import { classifyStep } from '../classify';
import { clarifyStep, type ClarifyInput } from '../clarify';
import { LlmPartialUsageError } from '../../../lib/llm/partialUsage';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';

const messageId = 'msg_spend' as Id<'inboundMessages'>;
const usage = (n: number) => ({ promptTokens: n, completionTokens: n, totalTokens: 2 * n });

interface LedgerRow {
	readonly feature: string;
	readonly tokenUsage: unknown;
	readonly modelUsed: unknown;
}

/** A step ctx whose ledger writes are collected; `routes` adds the step's own reads. */
function makeCtx(routes: StepCtxRoutes = {}) {
	const ledger: LedgerRow[] = [];
	const ctx = makeStepCtx<ActionCtx>({
		...routes,
		mutations: {
			...routes.mutations,
			llmUsage: (args) => {
				ledger.push(args as LedgerRow);
				return undefined;
			},
		},
	});
	return { ctx, ledger };
}

const failedWith = (n: number) =>
	new LlmPartialUsageError(new Error('schema mismatch'), usage(n), 'model-x');

beforeEach(() => {
	mocks.runLlmObject.mockReset();
	mocks.runLlmText.mockReset();
	mocks.resolveLanguageModel.mockReset();
	mocks.resolveLanguageModel.mockReturnValue('mock-model');
});

describe('security_scan guard windows', () => {
	const guardCtx = (body: string) =>
		makeCtx({
			queries: {
				getMessage: { subject: 'Order help', textBody: body, htmlBody: null },
				isAgentEnabled: true,
			},
		});
	const benign = (n: number) => ({
		object: { isInjection: false, confidence: 0.05, reason: 'benign' },
		tokenUsage: usage(n),
		modelUsed: 'guard-model',
	});

	it('writes one row per window the guard classified', async () => {
		// Two windows: 8000 chars, then the rest.
		const body = 'benign filler. '.repeat(560);
		mocks.runLlmObject.mockResolvedValueOnce(benign(3)).mockResolvedValueOnce(benign(2));
		const { ctx, ledger } = guardCtx(body);

		await securityScanStep.execute(ctx, { inboundMessageId: messageId });

		expect(mocks.runLlmObject).toHaveBeenCalledTimes(2);
		expect(ledger).toEqual([
			{ feature: 'agent_security_scan', tokenUsage: usage(3), modelUsed: 'guard-model' },
			{ feature: 'agent_security_scan', tokenUsage: usage(2), modelUsed: 'guard-model' },
		]);
	});

	it('records a failed window that carries usage, and still fails open', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(failedWith(4));
		const { ctx, ledger } = guardCtx('Just a normal support question, thanks.');

		const { output } = await securityScanStep.execute(ctx, { inboundMessageId: messageId });

		expect(output.securityFlags.guardUnavailable).toBe(true);
		expect(ledger).toEqual([
			{ feature: 'agent_security_scan', tokenUsage: usage(4), modelUsed: 'model-x' },
		]);
	});

	it('records nothing for a failure that carries no usage', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('401 unauthorized'));
		const { ctx, ledger } = guardCtx('Just a normal support question, thanks.');

		await securityScanStep.execute(ctx, { inboundMessageId: messageId });

		expect(ledger).toEqual([]);
	});
});

describe('context_retrieval quarantined extraction', () => {
	it('records the extraction call', async () => {
		mocks.runLlmObject.mockResolvedValueOnce({
			object: { facts: ['Order #4821'], questions: ['Where is it?'] },
			tokenUsage: usage(7),
			modelUsed: 'guard-model',
		});
		const { ctx, ledger } = makeCtx();

		expect(await runQuarantinedExtraction(ctx, 'Where is order #4821?')).toContain('Order #4821');
		expect(ledger).toEqual([
			{ feature: 'agent_context_retrieval', tokenUsage: usage(7), modelUsed: 'guard-model' },
		]);
	});

	it('records a failed extraction that carries usage and still falls back', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(failedWith(5));
		const { ctx, ledger } = makeCtx();

		expect(await runQuarantinedExtraction(ctx, 'Where is order #4821?')).toBeNull();
		expect(ledger).toEqual([
			{ feature: 'agent_context_retrieval', tokenUsage: usage(5), modelUsed: 'model-x' },
		]);
	});
});

describe('classify', () => {
	const classifyCtx = () => makeCtx({ queries: { evaluateForMessage: { stances: [] } } });
	const input = { inboundMessageId: messageId, context: '[CONTEXT]' };

	it('records the call and still returns its usage for agentActions', async () => {
		mocks.runLlmObject.mockResolvedValueOnce({
			object: {
				category: 'support',
				priority: 'normal',
				sentiment: 'neutral',
				intent: 'question',
				confidence: 0.9,
			},
			tokenUsage: usage(11),
			modelUsed: 'classify-model',
		});
		const { ctx, ledger } = classifyCtx();

		const result = await classifyStep.execute(ctx, input);

		expect(result.tokenUsage).toEqual(usage(11));
		expect(ledger).toEqual([
			{ feature: 'agent_classify', tokenUsage: usage(11), modelUsed: 'classify-model' },
		]);
	});

	it('records a failed call that carries usage, then fails the step', async () => {
		const error = failedWith(6);
		mocks.runLlmObject.mockRejectedValueOnce(error);
		const { ctx, ledger } = classifyCtx();

		await expect(classifyStep.execute(ctx, input)).rejects.toBe(error);
		expect(ledger).toEqual([
			{ feature: 'agent_classify', tokenUsage: usage(6), modelUsed: 'model-x' },
		]);
	});
});

describe('clarify', () => {
	const input: ClarifyInput = {
		inboundMessageId: messageId,
		context: 'Customer: can we push the launch and what would that cost?',
		classification: {
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'question',
			confidence: 0.9,
		},
	};
	const clarifyCtx = () =>
		makeCtx({
			queries: {
				getAskEagernessInternal: { mode: null },
				getMessage: { contextCoverage: { lowCoverage: true }, contactId: 'contact_test' },
			},
			mutations: { recordClarificationAsk: undefined, resolveFills: { fills: [] } },
		});
	const slots = {
		object: {
			slots: [
				{
					slotType: 'decision',
					question: 'Should we agree to push the launch date?',
					answerableFromContext: false,
					decisionRelevant: true,
					options: [],
				},
			],
		},
		tokenUsage: usage(1),
		modelUsed: 'clarify-model',
	};
	const sample = (text: string, n: number) => ({
		text,
		tokenUsage: usage(n),
		modelUsed: 'clarify-model',
	});

	it('records the slot, sample, divergence and localize calls, a failed sample included', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce(slots)
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0] },
				tokenUsage: usage(5),
				modelUsed: 'clarify-model',
			})
			// Localize: the first call and the retry for what it left out.
			.mockResolvedValueOnce({ object: { translations: [] }, tokenUsage: usage(6) })
			.mockRejectedValueOnce(failedWith(7));
		mocks.runLlmText
			.mockResolvedValueOnce(sample('Yes, we can push to March.', 2))
			.mockRejectedValueOnce(failedWith(3))
			.mockResolvedValueOnce(sample('No, the date is fixed.', 4));
		const { ctx, ledger } = clarifyCtx();

		const { output } = await clarifyStep.execute(ctx, input);

		expect(output.questions).toHaveLength(1);
		expect(ledger.map((row) => [row.feature, row.tokenUsage])).toEqual([
			['agent_clarify', usage(1)],
			['agent_clarify', usage(2)],
			['agent_clarify', usage(3)],
			['agent_clarify', usage(4)],
			['agent_clarify', usage(5)],
			// Localize reports its two calls as one sum, the failed retry included.
			['agent_clarify', usage(13)],
		]);
	});

	it('keeps what the calls before a fail-soft exit spent', async () => {
		mocks.runLlmObject.mockResolvedValueOnce(slots).mockRejectedValueOnce(failedWith(9));
		mocks.runLlmText
			.mockResolvedValueOnce(sample('Yes, we can push to March.', 2))
			.mockResolvedValueOnce(sample('No, the date is fixed.', 3))
			.mockResolvedValueOnce(sample('Maybe — let me check.', 4));
		const { ctx, ledger } = clarifyCtx();

		const { output } = await clarifyStep.execute(ctx, input);

		expect(output.resolution).toBe('fail_soft');
		expect(ledger.map((row) => row.tokenUsage)).toEqual([
			usage(1),
			usage(2),
			usage(3),
			usage(4),
			usage(9),
		]);
	});
});
