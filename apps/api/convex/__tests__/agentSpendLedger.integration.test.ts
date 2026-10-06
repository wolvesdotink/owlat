/**
 * The Team Inbox agent's spend reaches the ledger the spend ceiling reads
 * (#1259). The real walker runs one inbound message from `start` through every
 * step up to `route`: guard → quarantined extraction → classify → clarify →
 * draft → self-check. Each billed call must leave exactly one `llmUsageEvents`
 * row, the budget status must count them, and with a daily ceiling set the
 * agent's own spend alone must withhold autonomous auto-send. Before the fix only
 * the self-check reached the ledger, so the same run stayed under the ceiling.
 *
 * The LLM dispatch seam and the model factory are mocked; everything else (the
 * walker, the lifecycle, the ledger mutation, the budget query) is real.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { LlmPartialUsageError } from '../lib/llm/partialUsage';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	runLlmText: vi.fn(),
	runLlmTextWithTools: vi.fn(),
}));

vi.mock('../lib/llm/dispatch', async () => ({
	...(await vi.importActual<object>('../lib/llm/dispatch')),
	runLlmObject: mocks.runLlmObject,
	runLlmText: mocks.runLlmText,
	runLlmTextWithTools: mocks.runLlmTextWithTools,
}));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
	resolveLanguageModelForClassifiedDraft: vi.fn(async () => 'mock-model'),
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) => !path.includes('knowledgeExtraction') && !path.includes('llmProvider')
	)
);

type Harness = ReturnType<typeof convexTest>;

/** 100k in + 10k out on gpt-4o: $0.25 + $0.10 = $0.35 a call. */
const CALL_USAGE = { promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 };
const CALL_COST = 0.35;
const MODEL = 'gpt-4o';
const billed = <T extends object>(body: T) => ({
	...body,
	tokenUsage: CALL_USAGE,
	modelUsed: MODEL,
});

/** Answer each structured call by the prompt that asked for it. */
function answerObjectCalls() {
	mocks.runLlmObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
		if (prompt.includes('security classifier')) {
			return billed({ object: { isInjection: false, confidence: 0.02, reason: 'benign' } });
		}
		if (prompt.includes('QUARANTINED extractor')) {
			return billed({ object: { facts: ['Asks about a refund'], questions: ['Refund?'] } });
		}
		if (prompt.includes('Identify the SLOTS')) return billed({ object: { slots: [] } });
		if (prompt.includes('strict reviewer')) {
			return billed({ object: { score: 0.9, complete: true, grounded: true, flags: [] } });
		}
		return billed({
			object: {
				category: 'support',
				priority: 'normal',
				sentiment: 'neutral',
				intent: 'question',
				confidence: 0.9,
				needsResponse: true,
			},
		});
	});
}

async function seedMessage(t: Harness): Promise<Id<'inboundMessages'>> {
	await enableFeatures(t, ['ai.agent']);
	return t.run(async (ctx) => {
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: 0.8,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		// Subject + body stay at 10 chars, under the retrieval threshold, so the
		// briefing skips the embedding search this suite does not fake.
		return ctx.db.insert('inboundMessages', {
			messageId: 'msg-1259',
			from: 'jonas@example.com',
			to: 'support@owlat.app',
			subject: 'Hi',
			textBody: 'Refund?',
			processingStatus: 'received',
			receivedAt: Date.now(),
		});
	});
}

/**
 * Run the walker the way the scheduler would: `start`, then each `runStep` it
 * schedules, in order, until it schedules `route` or nothing. Returns the kinds
 * it ran. Fake timers keep convex-test from firing the scheduled runs itself.
 */
async function walkToRoute(t: Harness, inboundMessageId: Id<'inboundMessages'>) {
	await t.action(internal.agent.walker.start, { inboundMessageId });
	const ran: string[] = [];
	const done = new Set<string>();
	for (;;) {
		const next = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).find(
				(f) =>
					f.name.includes('walker') &&
					f.name.includes('runStep') &&
					f.state.kind === 'pending' &&
					!done.has(f._id)
			)
		);
		if (!next) return ran;
		done.add(next._id);
		const args = next.args[0] as { kind: string };
		if (args.kind === 'route') return ran;
		ran.push(args.kind);
		await t.action(internal.agent.walker.runStep, args as never);
	}
}

const ledger = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.query('llmUsageEvents').collect()).map((row) => ({
			feature: row.feature,
			totalTokens: row.totalTokens,
		}))
	);

beforeEach(() => {
	vi.useFakeTimers();
	mocks.runLlmObject.mockReset();
	mocks.runLlmText.mockReset();
	mocks.runLlmTextWithTools.mockReset();
	answerObjectCalls();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	delete process.env['AI_SPEND_DAILY_BUDGET_USD'];
});

describe('Team Inbox agent spend in the ledger (#1259)', () => {
	it('writes one row per billed call of a full run, and the budget counts them', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		mocks.runLlmTextWithTools.mockResolvedValueOnce(
			billed({ text: 'Hi Jonas, your refund is on its way.' })
		);

		const ran = await walkToRoute(t, messageId);

		expect(ran).toEqual(['security_scan', 'context_retrieval', 'classify', 'clarify', 'draft']);
		const rows = await ledger(t);
		expect(rows.map((row) => row.feature).sort()).toEqual(
			[
				'agent_classify',
				'agent_clarify',
				'agent_context_retrieval',
				'agent_draft',
				'agent_draft_selfcheck',
				'agent_security_scan',
			].sort()
		);
		expect(rows.every((row) => row.totalTokens === CALL_USAGE.totalTokens)).toBe(true);

		// agentActions keeps the per-step view: classify, clarify and draft
		// carry the usage their step returned.
		const stepUsage = await t.run(async (ctx) =>
			(await ctx.db.query('agentActions').collect())
				.filter((action) => action.tokenUsage !== undefined)
				.map((action) => action.actionType)
				.sort()
		);
		expect(stepUsage).toEqual(['clarify', 'classify', 'draft']);

		process.env['AI_SPEND_DAILY_BUDGET_USD'] = '100';
		const status = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(status.daily.spentUsd).toBeCloseTo(6 * CALL_COST);
	});

	it('withholds autonomous auto-send once the agent’s own spend crosses the ceiling', async () => {
		// Above one self-check, below the whole run.
		process.env['AI_SPEND_DAILY_BUDGET_USD'] = '1';
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		mocks.runLlmTextWithTools.mockResolvedValueOnce(
			billed({ text: 'Hi Jonas, your refund is on its way.' })
		);

		const before = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(before.autonomousAutoSendAllowed).toBe(true);

		await walkToRoute(t, messageId);

		const after = await t.query(internal.analytics.spendBudget.getBudgetStatus, {});
		expect(after.daily.spentUsd).toBeGreaterThan(1);
		expect(after.autonomousAutoSendAllowed).toBe(false);
		expect(after.reason).toMatch(/spend budget/i);
	});

	it('records a draft step that fails after a paid tool step once', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		mocks.runLlmTextWithTools.mockRejectedValueOnce(
			new LlmPartialUsageError(new Error('provider down'), CALL_USAGE, MODEL)
		);

		await walkToRoute(t, messageId);

		const message = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('failed');
		const draftRows = (await ledger(t)).filter((row) => row.feature.startsWith('agent_draft'));
		// No self-check ran, and the failed step put no usage on agentActions.
		expect(draftRows).toEqual([{ feature: 'agent_draft', totalTokens: CALL_USAGE.totalTokens }]);
		const draftAction = await t.run(async (ctx) =>
			(await ctx.db.query('agentActions').collect()).find((a) => a.actionType === 'draft')
		);
		expect(draftAction?.status).toBe('failed');
		expect(draftAction?.tokenUsage).toBeUndefined();
	});
});
