/**
 * The Phase 2 message bundle beside the Team classifier (ADR-0073, D9): with
 * the switches off nothing is scheduled; with them on the bundle is scheduled
 * with today's verdict as its baseline, and the step's output and route are
 * exactly what they are with the switches off. No model or database runs.
 */

import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRoutingPolicy, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { HandlingRuleOutcome } from '../../../../mail/handlingRules/engine';

const runLlmObjectMock = vi.fn();
vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmObject: (a: unknown) => runLlmObjectMock(a as never),
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: () => ({}) as never,
}));

import { classifyStep } from '../index';

const inert: HandlingRuleOutcome = {
	matchedInstructions: [],
	autoArchive: false,
	stances: [],
	restrictsAutoSend: false,
	reasons: [],
};

function fakeCtx(policy: ResolvedRoutingPolicy) {
	const scheduled: { name: string; args: unknown }[] = [];
	const ctx = {
		runQuery: vi.fn(async (reference: unknown) =>
			getFunctionName(reference as never).includes('getResolved') ? policy : inert
		),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, reference: unknown, args: unknown) => {
				scheduled.push({ name: getFunctionName(reference as never), args });
			}),
		},
	};
	return { ctx: ctx as never, scheduled };
}

const input = { inboundMessageId: 'msg1' as never, context: '[CONTEXT]' };
const runCtx = { inboundMessageId: 'msg1' as never } as never;

function classification(over: Record<string, unknown> = {}) {
	runLlmObjectMock.mockResolvedValue({
		object: {
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'question',
			confidence: 0.9,
			kind: 'personal',
			needsResponse: true,
			language: 'de',
			importance: 0.5,
			...over,
		},
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
}

const OFF = resolveRoutingPolicy(null);
const ON = resolveRoutingPolicy({
	policyVersion: 2,
	categoryDisplayBundle: 'enforce',
	dispositionAdvisoryBundle: 'enforce',
});

beforeEach(() => runLlmObjectMock.mockReset());

describe('the classifier’s Phase 2 hook', () => {
	it('schedules nothing while the switches are off', async () => {
		classification();
		const { ctx, scheduled } = fakeCtx(OFF);
		await classifyStep.execute(ctx, input);
		expect(scheduled).toEqual([]);
	});

	it.each([
		['a reply', {}, { category: 'support', disposition: 'reply' }],
		[
			'an informational update',
			{ needsResponse: false, intent: 'information', kind: 'update' },
			{ category: 'support', disposition: 'informational' },
		],
		['spam', { category: 'spam' }, { category: 'spam', disposition: 'informational' }],
	])(
		'compares %s with today’s verdict and routes exactly as today',
		async (_name, over, baseline) => {
			classification(over);
			const off = fakeCtx(OFF);
			const today = await classifyStep.execute(off.ctx, input);
			classification(over);
			const on = fakeCtx(ON);
			const withBundle = await classifyStep.execute(on.ctx, input);

			expect(withBundle).toEqual(today);
			expect(classifyStep.route(withBundle.output, input, runCtx)).toEqual(
				classifyStep.route(today.output, input, runCtx)
			);
			expect(on.scheduled).toEqual([
				{
					name: 'decision/bundleActions:teamMessage',
					args: { inboundMessageId: 'msg1', baseline, language: 'de' },
				},
			]);
		}
	);
});
