/**
 * A walker step's own outputs land with the step's commit and never without
 * it. For each core step module: a step that fails after `execute` returned
 * (its `route` throws) leaves none of its outputs behind, and the outputs of
 * a step whose message moved on while it ran are dropped. The LLM dispatch
 * seam and the model factory are mocked; the walker, its commit and the
 * owning modules' write helpers are real. Fake timers keep convex-test from
 * firing the scheduled runs itself.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_HOLD_ERROR_MESSAGE } from '@owlat/shared/aiRouting';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { contextRetrievalStep } from '../agent/steps/context_retrieval';
import { securityScanStep } from '../agent/steps/security_scan';
import { clarifyStep } from '../agent/steps/clarify';
import { classifyStep } from '../agent/steps/classify';
import { draftStep } from '../agent/steps/draft';
import { routeStep } from '../agent/steps/route';
import type { AgentStepKind } from '../agent/steps/types';
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
	priority: 'normal',
	sentiment: 'neutral',
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
			to: 'support@owlat.example',
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

const shadowRowsOf = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run((ctx) =>
		ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_message', (q) => q.eq('inboundMessageId', id))
			.collect()
	);

/** The walker runs still waiting to fire, by kind. */
const pendingKinds = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((f) => f.name.includes('walker') && f.state.kind === 'pending')
			.map((f) => (f.args[0] as { kind: string }).kind)
	);

/** The shadow decision bundles scheduled, by function name. */
const pendingBundles = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((f) => f.name.includes('bundleActions') && f.state.kind === 'pending')
			.map((f) => f.name)
	);

const runStep = (t: Harness, id: Id<'inboundMessages'>, kind: AgentStepKind, input: object) =>
	t.action(internal.agent.walker.runStep, { inboundMessageId: id, kind, input });

/** The step fails after `execute` returned: its route throws. */
function failRoute(module: { route: (...args: never[]) => unknown }): void {
	vi.spyOn(module as { route: () => unknown }, 'route').mockImplementation(() => {
		throw new Error('route broke');
	});
}

/** The step failed, against its row, and nothing comes next. */
async function expectFailedStep(t: Harness, id: Id<'inboundMessages'>, kind: AgentStepKind) {
	const message = await read(t, id);
	expect(message.processingStatus).toBe('failed');
	expect(message.errorMessage).toBe('route broke');
	expect((await actionsOf(t, id)).map((a) => [a.actionType, a.status])).toEqual([[kind, 'failed']]);
	expect(await pendingKinds(t)).toEqual([]);
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.runLlmObject.mockReset();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('context_retrieval', () => {
	it('records the context tier with the step and its next hop', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});

		await runStep(t, id, 'context_retrieval', { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.contextTier).toBe('normal');
		expect(message.contextCoverage).toMatchObject({ lowCoverage: true });
		expect(await pendingKinds(t)).toEqual(['classify']);
	});

	it('records no context tier when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		failRoute(contextRetrievalStep);

		await runStep(t, id, 'context_retrieval', { inboundMessageId: id });

		await expectFailedStep(t, id, 'context_retrieval');
		const message = await read(t, id);
		expect(message.contextTier).toBeUndefined();
		expect(message.contextCoverage).toBeUndefined();
	});

	it('drops the tier of a step whose message moved on while it ran', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		const execute = contextRetrievalStep.execute.bind(contextRetrievalStep);
		vi.spyOn(contextRetrievalStep, 'execute').mockImplementation(async (ctx, input) => {
			const result = await execute(ctx, input);
			// A person archived the message meanwhile.
			await t.run((db) => db.db.patch(id, { processingStatus: 'archived' }));
			return result;
		});

		await runStep(t, id, 'context_retrieval', { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.processingStatus).toBe('archived');
		expect(message.contextTier).toBeUndefined();
		// Nothing of the step lands: its row is closed and no next step runs.
		expect((await actionsOf(t, id)).map((a) => [a.status, a.errorMessage])).toEqual([
			['abandoned', 'The message moved on while the step ran'],
		]);
		expect(await pendingKinds(t)).toEqual([]);
	});

	it('records the tier of a resumed draft with its draft step', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'drafting',
			securityFlags: CLEAN_FLAGS,
			classification: CLASSIFICATION,
		});

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		expect((await read(t, id)).contextTier).toBe('normal');
		expect(await pendingKinds(t)).toEqual(['draft']);
	});
});

describe('security_scan', () => {
	it('stores the agent-off scan with the step', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'security_check' });

		await runStep(t, id, 'security_scan', { inboundMessageId: id });

		expect((await read(t, id)).securityFlags?.guardNotRun?.reason).toBe('agent_disabled');
	});

	it('stores no scan when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'security_check' });
		failRoute(securityScanStep);

		await runStep(t, id, 'security_scan', { inboundMessageId: id });

		await expectFailedStep(t, id, 'security_scan');
		expect((await read(t, id)).securityFlags).toBeUndefined();
	});

	it('stores the scan of a refused guard in the commit that holds the message', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'security_check' });
		mocks.runLlmObject.mockRejectedValue(new AdmissionRefusedError('daily_ceiling', 'ceiling'));

		await runStep(t, id, 'security_scan', { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.securityFlags?.guardNotRun?.reason).toBe('budget_refused');
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe(BUDGET_HOLD_ERROR_MESSAGE);
		expect(message.budgetHold).toMatchObject({ reason: 'daily_ceiling' });
	});
});

describe('classify', () => {
	function bundleWrites() {
		vi.spyOn(classifyStep, 'execute').mockResolvedValue({
			output: {
				category: 'support',
				priority: 'normal',
				sentiment: 'neutral',
				intent: 'question',
				confidence: 0.9,
			},
			writes: [
				{
					kind: 'decision_bundle',
					bundle: { bundle: 'team_message', baseline: { category: 'support' } },
				},
			],
		} as never);
	}

	const classifyInput = (id: Id<'inboundMessages'>) => ({
		inboundMessageId: id,
		context: 'briefing',
	});

	it('schedules its decision bundle with the step', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		bundleWrites();

		await runStep(t, id, 'classify', classifyInput(id));

		expect(await pendingBundles(t)).toEqual(['decision/bundleActions:teamMessage']);
		expect(await pendingKinds(t)).toEqual(['clarify']);
	});

	it('schedules no bundle when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		bundleWrites();
		failRoute(classifyStep);

		await runStep(t, id, 'classify', classifyInput(id));

		await expectFailedStep(t, id, 'classify');
		expect(await pendingBundles(t)).toEqual([]);
	});
});

describe('clarify', () => {
	async function withMemory(t: Harness): Promise<Id<'clarificationMemory'>> {
		return t.run((ctx) =>
			ctx.db.insert('clarificationMemory', {
				slotType: 'decision',
				questionKey: 'decision::push the launch',
				questionText: 'Push the launch?',
				answerValue: 'Yes',
				source: 'agent',
				answerCount: 1,
				useCount: 0,
				createdAt: 1,
				updatedAt: 1,
			})
		);
	}

	function clarifyWrites(rowId: Id<'clarificationMemory'>) {
		vi.spyOn(clarifyStep, 'execute').mockResolvedValue({
			output: {
				questions: [{ id: 'clarify_1', slotType: 'date_time', text: 'When?' }],
				memoryAnswers: [],
				resolution: 'questions_emitted',
			},
			writes: [
				{ kind: 'standing_answers_used', rowIds: [rowId] },
				{
					kind: 'clarification_ask',
					source: 'agent',
					slotTypes: ['date_time'],
					questionCount: 1,
					predictedValue: 0.5,
				},
			],
		});
	}

	const clarifyInput = (id: Id<'inboundMessages'>) => ({
		inboundMessageId: id,
		context: 'briefing',
		classification: CLASSIFICATION,
	});

	it('counts the answer used and logs the ask with the step', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		const rowId = await withMemory(t);
		clarifyWrites(rowId);

		await runStep(t, id, 'clarify', clarifyInput(id));

		expect((await read(t, id)).processingStatus).toBe('awaiting_clarification');
		expect((await t.run((ctx) => ctx.db.get(rowId)))!.useCount).toBe(1);
		expect(await t.run((ctx) => ctx.db.query('clarificationAskLog').collect())).toHaveLength(1);
	});

	it('counts and logs nothing when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: CLEAN_FLAGS,
		});
		const rowId = await withMemory(t);
		clarifyWrites(rowId);
		failRoute(clarifyStep);

		await runStep(t, id, 'clarify', clarifyInput(id));

		await expectFailedStep(t, id, 'clarify');
		expect((await t.run((ctx) => ctx.db.get(rowId)))!.useCount).toBe(0);
		expect(await t.run((ctx) => ctx.db.query('clarificationAskLog').collect())).toEqual([]);
	});
});

describe('draft', () => {
	const DRAFT = 'Your refund is on its way.';

	function draftWrites(onExecute?: () => Promise<void>) {
		vi.spyOn(draftStep, 'execute').mockImplementation(async () => {
			await onExecute?.();
			return {
				output: {
					draftResponse: DRAFT,
					draftSubject: 'Re: Hi',
					confidenceScore: 0.9,
					category: 'support',
					confidence: 0.9,
					draftQuality: null,
				},
				writes: [
					{
						kind: 'draft_output',
						draftResponse: DRAFT,
						draftSubject: 'Re: Hi',
						confidenceScore: 0.9,
					},
				],
			};
		});
	}

	const draftInput = (id: Id<'inboundMessages'>) => ({
		inboundMessageId: id,
		context: 'briefing',
		classification: CLASSIFICATION,
	});

	it('stores the draft with the step and its route hop', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		draftWrites();

		await runStep(t, id, 'draft', draftInput(id));

		expect((await read(t, id)).draftResponse).toBe(DRAFT);
		expect(await pendingKinds(t)).toEqual(['route']);
	});

	it('stores no draft when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		draftWrites();
		failRoute(draftStep);

		await runStep(t, id, 'draft', draftInput(id));

		await expectFailedStep(t, id, 'draft');
		expect((await read(t, id)).draftResponse).toBeUndefined();
	});

	it('stores no draft on a message that left drafting while it was written', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		draftWrites(async () => {
			await t.run((ctx) => ctx.db.patch(id, { processingStatus: 'archived' }));
		});

		await runStep(t, id, 'draft', draftInput(id));

		const message = await read(t, id);
		expect(message.processingStatus).toBe('archived');
		expect(message.draftResponse).toBeUndefined();
		expect((await actionsOf(t, id)).map((a) => a.status)).toEqual(['abandoned']);
		expect(await pendingKinds(t)).toEqual([]);
	});

	it('ends the step where the draft fence held the message, without routing it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'drafting', securityFlags: CLEAN_FLAGS });
		vi.spyOn(draftStep, 'execute').mockResolvedValue({
			output: {
				draftResponse: 'It ships on [[delivery date]].',
				draftSubject: 'Re: Hi',
				confidenceScore: 0.9,
				category: 'support',
				confidence: 0.9,
				draftQuality: null,
			},
			// A draft with a gap nobody agreed to: the write-side fence holds it.
			writes: [
				{
					kind: 'draft_output',
					draftResponse: 'It ships on [[delivery date]].',
					draftSubject: 'Re: Hi',
					confidenceScore: 0.9,
				},
			],
		});

		await runStep(t, id, 'draft', draftInput(id));

		const message = await read(t, id);
		expect(message.processingStatus).toBe('awaiting_clarification');
		expect(message.draftResponse).toBeUndefined();
		expect((await actionsOf(t, id)).map((a) => a.status)).toEqual(['completed']);
		expect(await pendingKinds(t)).toEqual([]);
	});
});

describe('route', () => {
	const routeInput = (id: Id<'inboundMessages'>) => ({
		inboundMessageId: id,
		confidence: 0.9,
		category: 'support',
		draftQuality: null,
	});

	async function drafted(t: Harness) {
		await enableFeatures(t, ['ai.agent']);
		return insertMessage(t, {
			processingStatus: 'drafting',
			securityFlags: CLEAN_FLAGS,
			classification: CLASSIFICATION,
			draftResponse: 'Your refund is on its way.',
			draftSubject: 'Re: Hi',
		});
	}

	it('records the decision and its shadow observation with the transition', async () => {
		const t = convexTest(schema, modules);
		const id = await drafted(t);

		await runStep(t, id, 'route', routeInput(id));

		const message = await read(t, id);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.agentDecision).toMatchObject({ decision: 'human_review', confidence: 0.9 });
		expect(await shadowRowsOf(t, id)).toHaveLength(1);
	});

	it('records no decision or observation when the step fails after execute', async () => {
		const t = convexTest(schema, modules);
		const id = await drafted(t);
		failRoute(routeStep);

		await runStep(t, id, 'route', routeInput(id));

		await expectFailedStep(t, id, 'route');
		expect((await read(t, id)).agentDecision).toBeUndefined();
		expect(await shadowRowsOf(t, id)).toEqual([]);
	});
	it('neither approves nor records a decision once the message left drafting', async () => {
		const t = convexTest(schema, modules);
		const id = await drafted(t);
		const execute = routeStep.execute.bind(routeStep);
		vi.spyOn(routeStep, 'execute').mockImplementation(async (ctx, input) => {
			const result = await execute(ctx, input);
			// A person sent it to review meanwhile.
			await t.run((db) => db.db.patch(id, { processingStatus: 'draft_ready' }));
			return result;
		});

		await runStep(t, id, 'route', routeInput(id));

		const message = await read(t, id);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.agentDecision).toBeUndefined();
		expect(await shadowRowsOf(t, id)).toEqual([]);
		expect((await actionsOf(t, id)).map((a) => a.status)).toEqual(['abandoned']);
	});

	it('records nothing for a message a person took over while it was routed', async () => {
		const t = convexTest(schema, modules);
		const id = await drafted(t);
		const execute = routeStep.execute.bind(routeStep);
		vi.spyOn(routeStep, 'execute').mockImplementation(async (ctx, input) => {
			const result = await execute(ctx, input);
			await t.run((db) => db.db.patch(id, { manualTakeoverAt: 1 }));
			return result;
		});

		await runStep(t, id, 'route', routeInput(id));

		const message = await read(t, id);
		expect(message.processingStatus).toBe('drafting');
		expect(message.agentDecision).toBeUndefined();
		expect((await actionsOf(t, id)).map((a) => [a.status, a.errorMessage])).toEqual([
			['abandoned', 'A person took over the reply'],
		]);
	});
});
