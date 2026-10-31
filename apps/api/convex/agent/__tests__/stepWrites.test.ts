/**
 * The step-write gate and dispatcher of the walker's commit
 * (`agent/stepWrites.ts`): when a step's writes may still land, and that an
 * observation write failing never takes the commit down while a write later
 * steps act on does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

const mocks = vi.hoisted(() => ({
	applyAgentDecision: vi.fn(),
	applyDraftOutput: vi.fn(),
	applyShadowDecision: vi.fn(),
}));

vi.mock('../../inbox/stepOutputs', async () => ({
	...(await vi.importActual<object>('../../inbox/stepOutputs')),
	applyAgentDecision: mocks.applyAgentDecision,
	applyDraftOutput: mocks.applyDraftOutput,
}));
vi.mock('../shadowScorecard', async () => ({
	...(await vi.importActual<object>('../shadowScorecard')),
	applyShadowDecision: mocks.applyShadowDecision,
}));

import { applyStepWrites, isStepCurrent, type StepWrite } from '../stepWrites';

const id = 'msg_1' as Id<'inboundMessages'>;
const ctx = {} as MutationCtx;
const message = (fields: Partial<Doc<'inboundMessages'>>) =>
	({ processingStatus: 'drafting', ...fields }) as Doc<'inboundMessages'>;

const decision: StepWrite = {
	kind: 'agent_decision',
	decision: 'human_review',
	reason: 'held',
	confidence: 0.5,
};
const shadow: StepWrite = {
	kind: 'shadow_decision',
	category: 'support',
	wouldHaveSent: false,
	reason: 'held',
	confidence: 0.5,
};
const draft: StepWrite = {
	kind: 'draft_output',
	draftResponse: 'Hi',
	draftSubject: 'Re: Hi',
	confidenceScore: 0.5,
};

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('isStepCurrent', () => {
	it.each([
		['the message is still where the step began', message({}), 'drafting', true],
		['the message moved on', message({ processingStatus: 'archived' }), 'drafting', false],
		['a person took the reply over', message({ manualTakeoverAt: 1 }), 'drafting', false],
		['the message is gone', null, 'drafting', false],
		['the step began on no message', message({}), undefined, false],
	] as const)('%s → %s', (_case, current, ranIn, expected) => {
		expect(isStepCurrent(current, ranIn)).toBe(expected);
	});
});

describe('applyStepWrites', () => {
	it('applies every write in the order the step decided them', async () => {
		const order: string[] = [];
		mocks.applyShadowDecision.mockImplementation(async () => void order.push('shadow'));
		mocks.applyAgentDecision.mockImplementation(async () => void order.push('decision'));

		await applyStepWrites(ctx, id, [shadow, decision]);

		expect(order).toEqual(['shadow', 'decision']);
		expect(mocks.applyAgentDecision).toHaveBeenCalledWith(ctx, id, {
			decision: 'human_review',
			reason: 'held',
			confidence: 0.5,
		});
	});

	it('lands the rest of the commit when an observation write fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.applyShadowDecision.mockRejectedValue(new Error('scorecard write failed'));

		await expect(applyStepWrites(ctx, id, [shadow, decision])).resolves.toBeUndefined();
		expect(mocks.applyAgentDecision).toHaveBeenCalledTimes(1);
	});

	it('fails the commit when the draft cannot be stored', async () => {
		mocks.applyDraftOutput.mockRejectedValue(new Error('draft write failed'));

		await expect(applyStepWrites(ctx, id, [draft, decision])).rejects.toThrow('draft write failed');
		expect(mocks.applyAgentDecision).not.toHaveBeenCalled();
	});
});
