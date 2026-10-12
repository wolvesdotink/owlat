/**
 * A structured answer that stopped at its output ceiling is incomplete, and
 * `runLlmObject` rejects it centrally (ADR-0073). Here the real dispatch runs
 * over a mocked AI SDK that returns a schema-valid object with a length stop:
 * the injection guard must fail into `guardUnavailable` (closed for
 * auto-send), and the draft self-check must report unknown quality, which the
 * review gate never auto-approves. Both still meter the billed request.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx } from './stepCtx';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateObject: (args: unknown) => mocks.generateObject(args),
}));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'guard-model', specificationVersion: 'v2' })),
}));

import { securityScanStep } from '../security_scan';
import { runDraftSelfCheck } from '../../shared/draftSelfCheck';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';

const cutOff = (object: unknown) => ({
	object,
	usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
	finishReason: 'length',
});

function ctxWithLedger(routes: Parameters<typeof makeStepCtx>[0] = {}) {
	const ledger: Array<{ feature: string; requests: Array<{ usage?: unknown }> }> = [];
	const ctx = makeStepCtx<ActionCtx>({
		...routes,
		mutations: {
			...routes.mutations,
			llmUsage: (args) => {
				ledger.push(args as (typeof ledger)[number]);
				return undefined;
			},
		},
	});
	return { ctx, ledger };
}

beforeEach(() => {
	mocks.generateObject.mockReset();
});

describe('a structured answer cut off at its output ceiling', () => {
	it('makes the guard fail closed for auto-send (guardUnavailable), metered', async () => {
		// "Not an injection", but the verdict stopped mid-answer.
		mocks.generateObject.mockResolvedValue(
			cutOff({ isInjection: false, confidence: 0.05, reason: 'benign' })
		);
		const { ctx, ledger } = ctxWithLedger({
			queries: {
				getMessage: { subject: 'Order help', textBody: 'Where is my order?', htmlBody: null },
				isAgentEnabled: true,
			},
		});

		const { output } = await securityScanStep.execute(ctx, {
			inboundMessageId: 'msg_cut' as Id<'inboundMessages'>,
		});

		expect(output.securityFlags.guardUnavailable).toBe(true);
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		expect(ledger.flatMap((call) => call.requests.map((r) => r.usage))).toEqual([
			{ promptTokens: 40, completionTokens: 12, totalTokens: 52 },
		]);
	});

	it('makes the draft self-check report unknown quality, never a score', async () => {
		mocks.generateObject.mockResolvedValue(
			cutOff({ score: 0.97, complete: true, grounded: true, flags: [] })
		);
		const { ctx, ledger } = ctxWithLedger();

		const quality = await runDraftSelfCheck(ctx, {
			context: 'Customer: where is my order?',
			draft: 'Your order shipped yesterday.',
			spendLabel: 'agent_draft_selfcheck',
		});

		expect(quality).toBeNull();
		expect(ledger).toHaveLength(1);
		expect(ledger[0]!.feature).toBe('agent_draft_selfcheck');
	});
});
