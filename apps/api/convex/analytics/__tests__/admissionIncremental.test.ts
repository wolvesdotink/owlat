/**
 * Admission before every provider request (ADR-0073, Phase 1b): a call holds
 * its first request up front and grows the hold before each later one, so a
 * tool loop or a retry is bounded request by request, and a refusal stops the
 * call before the refused request leaves. The real AI SDK runs over a mock
 * provider model; the admission and ledger mutations are real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { newHarness } from '../../__tests__/testModules';
import { runLlmText, runLlmTextWithTools } from '../../lib/llm/dispatch';
import { stampModelEndpoint } from '../../lib/llm/modelEndpoint';
import { admissionRefusalOf } from '../../lib/llm/admissionPort';
import { meterLlmCall } from '../meteredSpend';
import { actionCtxOver, reconcileSpend } from '../../aiRouting/__tests__/spend.testlib';

afterEach(() => {
	vi.unstubAllEnvs();
});

const usage = {
	inputTokens: { total: 1_000, noCache: 1_000, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 100, text: 100, reasoning: undefined },
};

const toolCall = (id: string) => ({
	content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'lookup', input: '{"q":"x"}' }],
	finishReason: { unified: 'tool-calls' as const, raw: undefined },
	usage,
	warnings: [],
});
const answer = {
	content: [{ type: 'text' as const, text: 'done' }],
	finishReason: { unified: 'stop' as const, raw: undefined },
	usage,
	warnings: [],
};

function mockModel(results: unknown[]) {
	const queue = [...results];
	const model = new MockLanguageModelV3({
		modelId: 'gpt-4o',
		doGenerate: async () => {
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return next as never;
		},
	});
	return stampModelEndpoint(model, 'openai-native');
}

const lookup = tool({
	description: 'look something up',
	inputSchema: z.object({ q: z.string() }),
	execute: async () => 'found',
});

async function setup(dailyUsd: string) {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}

const holds = (t: ReturnType<typeof newHarness>) =>
	t.run((ctx) => ctx.db.query('llmReservations').collect());

describe('admission before every provider request', () => {
	it('grows one hold step by step through a tool loop, then settles it', async () => {
		const { t, ctx } = await setup('10');
		const model = mockModel([toolCall('a'), toolCall('b'), answer]);

		await meterLlmCall(ctx, { feature: 'agent_draft' }, (meter) =>
			runLlmTextWithTools({
				model,
				meter,
				messages: [{ role: 'user', content: 'hi' }],
				tools: { lookup },
				maxSteps: 5,
			})
		);

		const [hold] = await holds(t);
		// Three requests were sent: the hold covered each one before it left.
		expect(hold).toMatchObject({ status: 'settled', maxAttempts: 3 });
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => row.reservationId === hold!.reservationId)).toBe(true);
	});

	it('stops a tool loop before the request admission refuses, and records no request for it', async () => {
		// Each request is held at its output ceiling (16,384 tokens of gpt-4o,
		// about $0.17): $0.45 leaves room for two of them, not three.
		const { t, ctx } = await setup('0.45');
		const model = mockModel([toolCall('a'), toolCall('b'), answer]);

		const error = await meterLlmCall(ctx, { feature: 'agent_draft' }, (meter) =>
			runLlmTextWithTools({
				model,
				meter,
				messages: [{ role: 'user', content: 'hi' }],
				tools: { lookup },
				maxSteps: 5,
			})
		).catch((e: unknown) => e);

		expect(admissionRefusalOf(error)).toMatchObject({ reason: 'daily_ceiling' });
		const sent = model.doGenerateCalls.length;
		expect(sent).toBe(2);
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		// One row per request actually sent, and none for the refused one.
		expect(rows.filter((row) => row.feature === 'agent_draft')).toHaveLength(sent);
		const [hold] = await holds(t);
		expect(hold).toMatchObject({ status: 'settled', maxAttempts: sent });
	});

	it('reserves a retry before it is sent', async () => {
		const { t, ctx } = await setup('10');
		const overloaded = Object.assign(new Error('overloaded'), { statusCode: 529 });
		const model = mockModel([overloaded, answer]);

		await meterLlmCall(ctx, { feature: 'postbox_ask_thread' }, (meter) =>
			runLlmText({ model, meter, prompt: 'hi' })
		);

		const [hold] = await holds(t);
		expect(hold).toMatchObject({ status: 'settled', maxAttempts: 2 });
		expect(model.doGenerateCalls).toHaveLength(2);
	});
});

describe('hold sizing bounds what is billed (Sol r1 F1)', () => {
	it('keeps parallel non-Latin calls under the ceiling, however the provider tokenizes them', async () => {
		const { t, ctx } = await setup('0.1');
		// A provider that bills the most it could: one token per UTF-8 byte of
		// everything it was sent, and its whole output ceiling.
		const model = stampModelEndpoint(
			new MockLanguageModelV3({
				modelId: 'gpt-4o-mini',
				doGenerate: async (options) => {
					const bytes = new TextEncoder().encode(JSON.stringify(options.prompt)).length;
					return {
						content: [{ type: 'text', text: '好' }],
						finishReason: { unified: 'stop', raw: undefined },
						usage: {
							inputTokens: {
								total: bytes,
								noCache: bytes,
								cacheRead: undefined,
								cacheWrite: undefined,
							},
							outputTokens: {
								total: options.maxOutputTokens ?? 0,
								text: options.maxOutputTokens ?? 0,
								reasoning: undefined,
							},
						},
						warnings: [],
					};
				},
			}),
			'openai-native'
		);
		const prompt = '請把簽好的合約寄給我，謝謝。🙂'.repeat(4_000);

		const outcomes = await Promise.allSettled(
			Array.from({ length: 6 }, () =>
				meterLlmCall(ctx, { feature: 'agent_draft' }, (meter) =>
					runLlmText({ model, meter, prompt })
				)
			)
		);

		const spent = (await t.run((c) => c.db.query('llmUsageEvents').collect())).reduce(
			(sum, row) => sum + (row.costMicrousd ?? 0),
			0
		);
		expect(spent).toBeGreaterThan(0);
		expect(spent).toBeLessThanOrEqual(100_000);
		// Some calls were refused before they were sent.
		expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true);
		expect(model.doGenerateCalls.length).toBeLessThan(6);
	});
});
