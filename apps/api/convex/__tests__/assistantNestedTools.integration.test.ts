/**
 * The assistant under task policies and admission:
 *
 *  - nested tools cannot bypass the budget: a nested draft is admitted under
 *    the turn's root, refused before any request at the ceiling, and a nested
 *    retrieval embedding is held as the turn's interactive work, not as
 *    pipeline work that may spend past the advisory reserve;
 *  - retrieval is capped per turn by the task policy, parallel calls included;
 *  - a Stop keeps the billed usage of the turn and of its nested calls, and
 *    settles every hold;
 *  - a budget refusal is stored as its stable code and reason.
 *
 * The SDK runs over mock models; admission, ledger and the runner are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { getFunctionName } from 'convex/server';
import { MockLanguageModelV3 } from 'ai/test';
import type * as LlmProviderModule from '../lib/llmProvider';

const llm = vi.hoisted(() => ({ model: undefined as unknown }));
const sdk = vi.hoisted(() => ({ embed: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	embed: (args: unknown) => sdk.embed(args),
}));

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	return {
		...actual,
		resolveLanguageModel: vi.fn(async () => llm.model),
		resolveLanguageModelForUserText: vi.fn(async () => llm.model),
	};
});

import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { enableFeatures } from './factories';
import { TOOL_MODULES, buildAssistantTools } from '../assistant/tools';
import { RETRIEVAL_LIMIT_MESSAGE } from '../assistant/toolRegistry';
import { STOP_POLL_MS } from '../assistant/runner';
import { stampModelEndpoint } from '../lib/llm/modelEndpoint';
import { admissionRefusalOf } from '../lib/llm/admissionPort';
import { runEmbedding } from '../lib/llm/embed';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import { meterLlmCall } from '../analytics/meteredSpend';
import { insertLlmUsage } from '../analytics/ledgerInsert';
import { actionCtxOver, reconcileSpend } from '../aiRouting/__tests__/spend.testlib';

type Harness = ReturnType<typeof newHarness>;

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const toolOptions = (abortSignal?: AbortSignal): ToolExecutionOptions => ({
	toolCallId: 'call-1',
	messages: [],
	...(abortSignal ? { abortSignal } : {}),
});

/** The root a turn hands its tools: the turn's root, its call as the parent. */
const turnRoot: LlmRootContext = {
	rootRequestId: 'assistant:m1',
	parentCallId: 'turn-1',
	priority: 'interactive',
};

function draftModel(doGenerate?: MockLanguageModelV3['doGenerate']) {
	return stampModelEndpoint(
		new MockLanguageModelV3({
			modelId: 'gpt-4o',
			doGenerate:
				doGenerate ??
				(async () => ({
					content: [{ type: 'text', text: 'Dear Ada, ...' }],
					finishReason: { unified: 'stop', raw: undefined },
					usage,
					warnings: [],
				})),
		}),
		'openai-native'
	);
}

async function setup(dailyUsd?: string) {
	if (dailyUsd !== undefined) vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	if (dailyUsd !== undefined) await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}

/** `ToolSet[name].execute`, typed loosely for the test. */
function run(tools: ToolSet, name: string, input: unknown, options = toolOptions()) {
	const execute = tools[name]?.execute;
	if (!execute) throw new Error(`no tool ${name}`);
	return Promise.resolve(execute(input as never, options));
}

const holdsOf = (t: Harness) => t.run((c) => c.db.query('llmReservations').collect());
const rowsOf = (t: Harness) => t.run((c) => c.db.query('llmUsageEvents').collect());

beforeEach(() => {
	sdk.embed.mockReset();
	llm.model = draftModel();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('retrieval per the task policy', () => {
	function fakeCtx() {
		return {
			// Flags (ai.knowledge on), graph retrieval, and the full-text lookup.
			runQuery: vi.fn(async (ref: unknown) => {
				const name = getFunctionName(ref as never);
				if (name.endsWith('getResolvedFlags')) return { 'ai.knowledge': true };
				if (name.endsWith('isGraphRetrievalEnabled')) return false;
				return { contacts: [], emails: [], campaigns: [] };
			}),
			runAction: vi.fn(async () => []),
		};
	}

	it('counts every retrieval of a turn against one allowance, parallel calls included', async () => {
		const ctx = fakeCtx();
		const tools = await buildAssistantTools(
			ctx as unknown as ActionCtx,
			{ canReadInbox: false },
			TOOL_MODULES,
			turnRoot,
			{ maxRetrievalCalls: 2 }
		);

		const results = await Promise.allSettled([
			run(tools, 'searchKnowledge', { query: 'a' }),
			run(tools, 'searchFiles', { query: 'b' }),
			run(tools, 'searchKnowledge', { query: 'c' }),
		]);

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
		expect((results[2] as PromiseRejectedResult).reason).toEqual(
			new Error(RETRIEVAL_LIMIT_MESSAGE)
		);
		// The refused search never ran: no search action, so no query embedding.
		expect(ctx.runAction).toHaveBeenCalledTimes(2);
		// Each search ran under the turn's root, its interactive priority included.
		for (const [, args] of ctx.runAction.mock.calls as unknown as [unknown, { root: unknown }][]) {
			expect(args.root).toEqual(turnRoot);
		}
		// A lookup that spends nothing is not a retrieval and is not counted.
		await run(tools, 'searchEverything', { query: 'Ada' });
		expect(ctx.runQuery).toHaveBeenCalled();
	});

	it('runs every retrieval when no cap is given', async () => {
		const ctx = fakeCtx();
		const tools = await buildAssistantTools(ctx as unknown as ActionCtx, { canReadInbox: true });
		for (let i = 0; i < 10; i++) await run(tools, 'searchKnowledge', { query: `q${i}` });
		expect(ctx.runAction).toHaveBeenCalledTimes(10);
	});

	it('scopes a nested knowledge search to the turn’s audience', async () => {
		for (const canReadInbox of [true, false]) {
			const ctx = fakeCtx();
			const tools = await buildAssistantTools(
				ctx as unknown as ActionCtx,
				{ canReadInbox },
				TOOL_MODULES,
				turnRoot
			);
			await run(tools, 'searchKnowledge', { query: 'a' });
			expect(ctx.runAction.mock.calls[0]?.[1 as never]).toMatchObject({
				includeInboxDerived: canReadInbox,
				scopeToContact: 'org-wide',
			});
		}
	});
});

describe('ai.knowledge (#1335)', () => {
	it('offers the knowledge search only while ai.knowledge is on, like Quick Query', async () => {
		const { t, ctx } = await setup();
		const off = await buildAssistantTools(ctx, { canReadInbox: true }, TOOL_MODULES, turnRoot);
		expect(Object.keys(off)).not.toContain('searchKnowledge');
		expect(Object.keys(off)).toContain('searchFiles');

		await enableFeatures(t, ['ai.knowledge']);
		const on = await buildAssistantTools(ctx, { canReadInbox: true }, TOOL_MODULES, turnRoot);
		expect(Object.keys(on)).toContain('searchKnowledge');
	});
});

describe('nested tools under admission', () => {
	it('refuses a nested draft at the ceiling before any request, with the stable code', async () => {
		const { t, ctx } = await setup('0.0001');
		const model = draftModel();
		llm.model = model;
		const tools = await buildAssistantTools(ctx, { canReadInbox: false }, TOOL_MODULES, turnRoot);

		const error = await run(tools, 'draftCampaignCopy', { brief: 'spring sale' }).catch(
			(e: unknown) => e
		);

		expect(admissionRefusalOf(error)).toMatchObject({
			code: AI_BUDGET_ERROR_CODE,
			reason: 'daily_ceiling',
		});
		expect(model.doGenerateCalls).toHaveLength(0);
		expect(await holdsOf(t)).toHaveLength(0);
		expect(await rowsOf(t)).toHaveLength(0);
	});

	it('admits a nested draft under the turn’s root, parent and interactive priority', async () => {
		const { t, ctx } = await setup('10');
		const tools = await buildAssistantTools(ctx, { canReadInbox: false }, TOOL_MODULES, turnRoot);

		await run(tools, 'draftCampaignCopy', { brief: 'spring sale' });

		const [hold] = await holdsOf(t);
		expect(hold).toMatchObject({
			status: 'settled',
			task: 'assistant.tool_draft',
			rootRequestId: 'assistant:m1',
			parentCallId: 'turn-1',
			priority: 'interactive',
		});
		const [row] = await rowsOf(t);
		expect(row).toMatchObject({
			feature: 'assistant_tool_draft',
			rootRequestId: 'assistant:m1',
			parentCallId: 'turn-1',
			reservationId: hold!.reservationId,
			totalTokens: 15,
		});
	});

	it('holds a nested retrieval embedding as the turn’s interactive work', async () => {
		const { t, ctx } = await setup('10');
		// $7.10 settled: past interactive work's line ($10 less the $2 advisory
		// reserve and the unused $1 triage allowance), inside the pipeline's.
		await t.run((c) =>
			insertLlmUsage(
				c,
				'agent_draft',
				{ promptTokens: 2_840_000, completionTokens: 0, totalTokens: 2_840_000 },
				'gpt-4o'
			)
		);
		sdk.embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 12 } });
		const embedder = stampModelEndpoint(
			{ modelId: 'text-embedding-3-small', specificationVersion: 'v2' } as never,
			'embedding:openai'
		);
		const search = (root: LlmRootContext) =>
			meterLlmCall(ctx, { feature: 'embedding_knowledge_search', root }, (meter) =>
				runEmbedding({ model: embedder, value: 'q', meter })
			);

		// Under the assistant turn: refused at the advisory reserve, no request.
		const refused = await search(turnRoot).catch((e: unknown) => e);
		expect(admissionRefusalOf(refused)).toMatchObject({ reason: 'daily_ceiling' });
		expect(sdk.embed).not.toHaveBeenCalled();

		// The same embedding under a root without a priority keeps its task's
		// (pipeline), as Team retrieval does today.
		await search({ rootRequestId: 'team:m2' });
		expect(sdk.embed).toHaveBeenCalledTimes(1);
	});

	it('ends a nested draft on Stop: its request stays on the ledger and its hold settles', async () => {
		const { t, ctx } = await setup('10');
		let started!: () => void;
		const isStarted = new Promise<void>((resolve) => (started = resolve));
		const model = draftModel(async (options) => {
			started();
			await new Promise((_, reject) =>
				options.abortSignal?.addEventListener('abort', () =>
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				)
			);
			throw new Error('unreachable');
		});
		llm.model = model;
		const tools = await buildAssistantTools(ctx, { canReadInbox: false }, TOOL_MODULES, turnRoot);
		const stop = new AbortController();

		const call = run(tools, 'draftCampaignCopy', { brief: 'x' }, toolOptions(stop.signal));
		await isStarted;
		stop.abort();

		await expect(call).rejects.toThrow();
		expect(model.doGenerateCalls).toHaveLength(1);
		const [hold] = await holdsOf(t);
		expect(hold?.status).toBe('settled');
		const draftRows = (await rowsOf(t)).filter((r) => r.feature === 'assistant_tool_draft');
		expect(draftRows).toHaveLength(1);
		expect(draftRows[0]).toMatchObject({ parentCallId: 'turn-1', isEstimated: true });
	});
});

/** A conversation with one user turn and the streaming assistant row the runner fills. */
async function seedTurn(t: Harness) {
	return t.run(async (c) => {
		const now = Date.now();
		const conversationId = await c.db.insert('aiConversations', {
			ownerId: 'user-a',
			title: 'Test',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 2,
		});
		await c.db.insert('aiMessages', {
			conversationId,
			ownerId: 'user-a',
			role: 'user',
			text: 'Write the spring sale copy.',
			status: 'complete',
			createdAt: now,
		});
		const assistantMessageId = await c.db.insert('aiMessages', {
			conversationId,
			ownerId: 'user-a',
			role: 'assistant',
			text: '',
			status: 'streaming',
			createdAt: now + 1,
		});
		return { conversationId, assistantMessageId };
	});
}

type StreamPart = Record<string, unknown> & { type: string };

function streamOf(parts: StreamPart[]): ReadableStream<never> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part as never);
			controller.close();
		},
	});
}

/** A stream that opens and then waits, until the request is aborted. */
function streamUntilAborted(signal: AbortSignal | undefined): ReadableStream<never> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: 'stream-start', warnings: [] } as never);
			signal?.addEventListener('abort', () =>
				controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
			);
		},
	});
}

describe('the assistant turn', () => {
	it('keeps the billed usage of a stopped turn and of its nested draft, and settles every hold', async () => {
		const { t } = await setup('10');
		const { conversationId, assistantMessageId } = await seedTurn(t);
		let streamCalls = 0;
		llm.model = stampModelEndpoint(
			new MockLanguageModelV3({
				modelId: 'gpt-4o',
				doStream: async (options) => {
					streamCalls += 1;
					if (streamCalls > 1) return { stream: streamUntilAborted(options.abortSignal) };
					return {
						stream: streamOf([
							{ type: 'stream-start', warnings: [] },
							{
								type: 'tool-call',
								toolCallId: 'tc1',
								toolName: 'draftCampaignCopy',
								input: JSON.stringify({ brief: 'spring sale' }),
							},
							{
								type: 'finish',
								finishReason: { unified: 'tool-calls', raw: undefined },
								usage,
							},
						]),
					};
				},
				// The nested draft is billed; the person presses Stop while it runs.
				doGenerate: async () => {
					await t.run((c) => c.db.patch(assistantMessageId, { status: 'stopped' }));
					return {
						content: [{ type: 'text', text: 'Spring sale!' }],
						finishReason: { unified: 'stop', raw: undefined },
						usage,
						warnings: [],
					};
				},
			}),
			'openai-native'
		);

		await t.action(internal.assistant.runner.run, {
			conversationId,
			assistantMessageId,
			ownerId: 'user-a',
		});

		const message = await t.run((c) => c.db.get(assistantMessageId));
		expect(message?.status).toBe('stopped');
		const holds = await holdsOf(t);
		expect(holds.length).toBeGreaterThanOrEqual(2);
		expect(holds.every((hold) => hold.status === 'settled')).toBe(true);
		const rows = await rowsOf(t);
		const turnRows = rows.filter((r) => r.feature === 'assistant_chat');
		const draftRows = rows.filter((r) => r.feature === 'assistant_tool_draft');
		// The turn's first step was billed and keeps its reported usage.
		expect(turnRows.find((r) => r.attempt === 1)).toMatchObject({
			totalTokens: 15,
			task: 'assistant.answer',
		});
		expect(draftRows).toEqual([
			expect.objectContaining({ totalTokens: 15, parentCallId: turnRows[0]!.requestId }),
		]);
	}, 20_000);

	it('notices a Stop while a nested draft waits on its provider, with no stream event (Sol r1 F1)', async () => {
		const { t } = await setup('10');
		const { conversationId, assistantMessageId } = await seedTurn(t);
		// Only the turn's stop watch runs on a faked interval; the draft advances
		// it by one check, so the abort can only come from that check.
		let abortedBeforeCheck: boolean | undefined;
		let abortReason: unknown;
		llm.model = stampModelEndpoint(
			new MockLanguageModelV3({
				modelId: 'gpt-4o',
				doStream: async () => ({
					stream: streamOf([
						{ type: 'stream-start', warnings: [] },
						{
							type: 'tool-call',
							toolCallId: 'tc1',
							toolName: 'draftCampaignCopy',
							input: JSON.stringify({ brief: 'spring sale' }),
						},
						{ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
					]),
				}),
				// The draft is blocked until it is cancelled. The person presses Stop
				// once it has started; nothing else happens on the stream.
				doGenerate: async (options) => {
					const signal = options.abortSignal!;
					const aborted = new Promise<unknown>((resolve) =>
						signal.addEventListener('abort', () => resolve(signal.reason), { once: true })
					);
					await t.run((c) => c.db.patch(assistantMessageId, { status: 'stopped' }));
					abortedBeforeCheck = signal.aborted;
					await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
					abortReason = await aborted;
					throw Object.assign(new Error('aborted'), { name: 'AbortError' });
				},
			}),
			'openai-native'
		);

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			await t.action(internal.assistant.runner.run, {
				conversationId,
				assistantMessageId,
				ownerId: 'user-a',
			});
		} finally {
			vi.useRealTimers();
		}

		// Aborted by the first stop check after Stop, not at the call's deadline.
		expect(abortedBeforeCheck).toBe(false);
		expect(abortReason).toBeDefined();
		expect((abortReason as { name?: string }).name).not.toBe('TimeoutError');
		expect((await t.run((c) => c.db.get(assistantMessageId)))?.status).toBe('stopped');
		// The aborted draft's request is on the ledger and every hold is settled.
		const draftRows = (await rowsOf(t)).filter((r) => r.feature === 'assistant_tool_draft');
		expect(draftRows).toHaveLength(1);
		const holds = await holdsOf(t);
		expect(holds.length).toBeGreaterThanOrEqual(2);
		expect(holds.every((hold) => hold.status === 'settled')).toBe(true);
	}, 20_000);

	it('stores a budget refusal as its code and reason, not as a sentence', async () => {
		const { t } = await setup('0.0001');
		const { conversationId, assistantMessageId } = await seedTurn(t);
		const model = draftModel();
		llm.model = model;

		await t.action(internal.assistant.runner.run, {
			conversationId,
			assistantMessageId,
			ownerId: 'user-a',
		});

		const message = await t.run((c) => c.db.get(assistantMessageId));
		expect(message).toMatchObject({
			status: 'error',
			budgetRefusal: { code: AI_BUDGET_ERROR_CODE, reason: 'daily_ceiling' },
		});
		expect(message?.errorMessage).toBeUndefined();
		expect(model.doStreamCalls).toHaveLength(0);
	});

	it('stores an @assistant reply’s budget refusal the same way', async () => {
		const { t } = await setup();
		const messageId = await t.run(async (c) => {
			const now = Date.now();
			const roomId = await c.db.insert('chatRooms', {
				kind: 'channel',
				name: 'general',
				normalizedName: 'general',
				visibility: 'public',
				createdBy: 'user-a',
				createdAt: now,
				updatedAt: now,
				lastMessageAt: now,
				messageCount: 0,
			});
			return c.db.insert('chatMessages', {
				roomId,
				authorId: 'system:assistant',
				text: '',
				createdAt: now,
				aiStatus: 'streaming',
			});
		});

		await t.mutation(internal.chat.messages.finalizeAssistantChatMessage, {
			messageId,
			text: '',
			status: 'error',
			budgetRefusal: { code: AI_BUDGET_ERROR_CODE, reason: 'monthly_ceiling' },
		});

		const message = await t.run((c) => c.db.get(messageId));
		expect(message?.budgetRefusal).toEqual({
			code: AI_BUDGET_ERROR_CODE,
			reason: 'monthly_ceiling',
		});
		// No English stand-in text: the web says why from the code and reason.
		expect(message?.text).toBe('');
	});
});

describe('visualization', () => {
	async function seedVisualization(t: Harness): Promise<Id<'visualizations'>> {
		return t.run((c) =>
			c.db.insert('visualizations', {
				title: 'Generating…',
				html: '',
				pinned: false,
				createdBy: 'user-a',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
	}

	it('stores a budget refusal as its code and reason, with no English sentence on the page', async () => {
		const { t } = await setup('0.0001');
		const id = await seedVisualization(t);

		await t.action(internal.visualizationAgentActions.generate, {
			visualizationId: id,
			prompt: 'Open rates by week',
		});

		const visualization = await t.run((c) => c.db.get(id));
		expect(visualization?.budgetRefusal).toEqual({
			code: AI_BUDGET_ERROR_CODE,
			reason: 'daily_ceiling',
		});
		expect(visualization?.html).toContain('Generation Failed');
		expect(visualization?.html).not.toMatch(/budget/i);
	});

	it('keeps the failure’s own message on the page for any other error', async () => {
		const { t } = await setup();
		const id = await seedVisualization(t);
		llm.model = draftModel(async () => {
			throw Object.assign(new Error('model unavailable'), { name: 'ProviderError' });
		});

		await t.action(internal.visualizationAgentActions.generate, {
			visualizationId: id,
			prompt: 'Open rates by week',
		});

		const visualization = await t.run((c) => c.db.get(id));
		expect(visualization?.budgetRefusal).toBeUndefined();
		expect(visualization?.html).toContain('model unavailable');
	});
});
