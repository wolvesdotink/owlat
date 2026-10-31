/**
 * The message bundle beside the Team classifier: with
 * the switches off nothing is scheduled; with them on the bundle is scheduled
 * with today's verdict as its baseline (the step returns it, and its commit
 * schedules it: `decision/schedule.ts` `scheduleTeamBundle`), and the step's
 * output and route are exactly what they are with the switches off. No model
 * or database runs.
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
import { scheduleTeamBundle, type TeamBundle } from '../../../../decision/schedule';
import { writesOf } from '../../__tests__/stepCtx';

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
			getFunctionName(reference as never).includes('schedulingGate')
				? { policy, isAllowed: true }
				: inert
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

/** Run the step, then schedule its bundles the way its commit does. */
async function classifyAndCommit(ctx: never) {
	const result = await classifyStep.execute(ctx, input);
	for (const write of writesOf(result.writes, 'decision_bundle')) {
		await scheduleTeamBundle(ctx, input.inboundMessageId, write['bundle'] as TeamBundle);
	}
	return result;
}
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
		await classifyAndCommit(ctx);
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
			const today = await classifyAndCommit(off.ctx);
			classification(over);
			const on = fakeCtx(ON);
			const withBundle = await classifyAndCommit(on.ctx);

			expect({ ...withBundle, writes: [] }).toEqual(today);
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
