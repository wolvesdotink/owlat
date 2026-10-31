/**
 * What one run of `agent/walker.runStep` and `agent/walker.resumeDraft` leaves
 * behind: the step's `agentActions` row, the message's processing status and
 * the next walker run it scheduled. The LLM dispatch seam and the model
 * factory are mocked; the walker, the lifecycle and the budget hold are real.
 * Fake timers keep convex-test from firing the scheduled runs itself.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_HOLD_ERROR_MESSAGE } from '@owlat/shared/aiRouting';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { contextRetrievalStep } from '../agent/steps/context_retrieval';
import { AdmissionRefusedError } from '../lib/llm/admissionPort';

const mocks = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../lib/llm/dispatch', async () => ({
	...(await vi.importActual<object>('../lib/llm/dispatch')),
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
}));
vi.mock('../lib/contactCountHelpers', async () => ({
	...(await vi.importActual<object>('../lib/contactCountHelpers')),
	incrementContactCount: vi.fn().mockResolvedValue(undefined),
	decrementContactCount: vi.fn().mockResolvedValue(undefined),
	getCachedContactCount: vi.fn().mockResolvedValue(0),
	reconcileContactCount: vi.fn().mockResolvedValue(undefined),
}));

const modules = import.meta.glob('../**/*.*s');

type Harness = TestConvex<typeof schema>;

const CLEAN_FLAGS = {
	injectionDetected: false,
	confidence: 0,
	spamScore: 0,
	phishingDetected: false,
	guardUnavailable: false,
	scanTimestamp: 1,
};

const CLASSIFICATION = {
	category: 'support',
	priority: 'normal' as const,
	sentiment: 'neutral' as const,
	intent: 'question',
	confidence: 0.9,
};

async function insertMessage(
	t: Harness,
	fields: Partial<Doc<'inboundMessages'>> & {
		processingStatus: Doc<'inboundMessages'>['processingStatus'];
	}
): Promise<Id<'inboundMessages'>> {
	return t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `msg-${Math.random().toString(36).slice(2)}`,
			from: 'customer@example.com',
			to: 'support@owlat.app',
			// Under the retrieval threshold, so the briefing makes no embedding search.
			subject: 'Hi',
			textBody: 'Refund?',
			receivedAt: Date.now(),
			...fields,
		})
	);
}

const read = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run(async (ctx) => (await ctx.db.get(id))!);

const actionsOf = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run((ctx) =>
		ctx.db
			.query('agentActions')
			.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', id))
			.collect()
	);

/** The walker runs still waiting to fire, as their `runStep` args. */
const pendingSteps = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((f) => f.name.includes('walker') && f.state.kind === 'pending')
			.map((f) => f.args[0] as { kind: string; input: Record<string, unknown> })
	);

beforeEach(() => {
	vi.useFakeTimers();
	mocks.runLlmObject.mockReset();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('walker.runStep', () => {
	it('an in-state step completes its row and schedules the next step', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'context_retrieval',
			input: { inboundMessageId: id },
		});

		const [action, ...rest] = await actionsOf(t, id);
		expect(rest).toEqual([]);
		expect(action).toMatchObject({ actionType: 'context_retrieval', status: 'completed' });
		expect(typeof action!.output).toBe('string');
		expect(action!.durationMs).toBeGreaterThanOrEqual(0);
		expect((await read(t, id)).processingStatus).toBe('classifying');
		const steps = await pendingSteps(t);
		expect(steps.map((s) => s.kind)).toEqual(['classify']);
		expect(steps[0]!.input).toMatchObject({ inboundMessageId: id });
	});

	it('a done step completes its row and schedules nothing', async () => {
		// The agent is off: the scan records itself and the run stops.
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'security_check' });

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'security_scan',
			input: { inboundMessageId: id },
		});

		const actions = await actionsOf(t, id);
		expect(actions.map((a) => [a.actionType, a.status])).toEqual([['security_scan', 'completed']]);
		expect(actions[0]!.output).toBeDefined();
		expect((await read(t, id)).processingStatus).toBe('security_check');
		expect(await pendingSteps(t)).toEqual([]);
	});

	it('a step that throws fails the message against its row and schedules nothing', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		vi.spyOn(contextRetrievalStep, 'execute').mockRejectedValue(new Error('retrieval broke'));

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'context_retrieval',
			input: { inboundMessageId: id },
		});

		const message = await read(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe('retrieval broke');
		const actions = await actionsOf(t, id);
		expect(actions.map((a) => [a.actionType, a.status])).toEqual([['context_retrieval', 'failed']]);
		expect(await pendingSteps(t)).toEqual([]);
	});

	it('a refused paid call holds the message and closes its row as abandoned', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		vi.spyOn(contextRetrievalStep, 'execute').mockRejectedValue(
			new AdmissionRefusedError('daily_ceiling', 'ceiling')
		);

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'context_retrieval',
			input: { inboundMessageId: id },
		});

		const message = await read(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe(BUDGET_HOLD_ERROR_MESSAGE);
		expect(message.budgetHold).toMatchObject({ reason: 'daily_ceiling' });
		const actions = await actionsOf(t, id);
		expect(actions.map((a) => [a.actionType, a.status])).toEqual([
			['context_retrieval', 'abandoned'],
		]);
		expect(await pendingSteps(t)).toEqual([]);
	});

	it('runs nothing for a message a person took over', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
			manualTakeoverAt: 1,
		});

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'context_retrieval',
			input: { inboundMessageId: id },
		});

		expect(await actionsOf(t, id)).toEqual([]);
		expect((await read(t, id)).processingStatus).toBe('classifying');
		expect(await pendingSteps(t)).toEqual([]);
	});
});

describe('walker.resumeDraft', () => {
	const openQuestion = {
		id: 'q1',
		slotType: 'order_number',
		text: 'Which order is this about?',
	};

	it('schedules the draft step with the rebuilt context and the stored classification', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'drafting',
			securityFlags: CLEAN_FLAGS,
			classification: CLASSIFICATION,
			pendingClarification: {
				questions: [{ ...openQuestion, answer: { value: 'A-123', source: 'user', at: 1 } }],
				askedAt: 1,
			},
		});

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const steps = await pendingSteps(t);
		expect(steps.map((s) => s.kind)).toEqual(['draft']);
		expect(steps[0]!.input).toMatchObject({
			inboundMessageId: id,
			classification: CLASSIFICATION,
		});
		expect(typeof steps[0]!.input['context']).toBe('string');
		expect((await read(t, id)).processingStatus).toBe('drafting');
	});

	it('drafts on a neutral classification when the message has none', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const steps = await pendingSteps(t);
		expect(steps.map((s) => s.kind)).toEqual(['draft']);
		expect(steps[0]!.input['classification']).toMatchObject({ category: 'other', confidence: 0 });
	});

	it('drafts on an empty context when the retrieval fails', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		vi.spyOn(contextRetrievalStep, 'execute').mockRejectedValue(new Error('retrieval broke'));

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const steps = await pendingSteps(t);
		expect(steps.map((s) => s.kind)).toEqual(['draft']);
		expect(steps[0]!.input['context']).toBe('');
	});

	it('goes back to asking when a question is still open without consent to gaps', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'drafting',
			securityFlags: CLEAN_FLAGS,
			classification: CLASSIFICATION,
			pendingClarification: { questions: [openQuestion], askedAt: 1 },
		});

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.processingStatus).toBe('awaiting_clarification');
		expect(message.pendingClarification?.questions.map((q) => q.id)).toEqual(['q1']);
		expect(await pendingSteps(t)).toEqual([]);
	});

	it('holds the message when the retrieval was refused for budget', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		vi.spyOn(contextRetrievalStep, 'execute').mockRejectedValue(
			new AdmissionRefusedError('monthly_ceiling', 'ceiling')
		);

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe(BUDGET_HOLD_ERROR_MESSAGE);
		expect(message.budgetHold).toMatchObject({
			reason: 'monthly_ceiling',
			missingJudgments: ['draft'],
		});
		expect(await pendingSteps(t)).toEqual([]);
	});

	it('does nothing for a message no longer in drafting', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'archived', securityFlags: CLEAN_FLAGS });

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		expect((await read(t, id)).processingStatus).toBe('archived');
		expect(await pendingSteps(t)).toEqual([]);
	});
});
