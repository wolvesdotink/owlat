/**
 * Tool rounds per the task policy (ADR-0073, Phase 5): a tool loop or a
 * tool-calling stream stops at the task's `maxToolRounds`, whatever step limit
 * the caller asked for. A task without one keeps the caller's limit, as today.
 * The real AI SDK runs over a scripted mock model; nothing reaches a provider.
 */

import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { DEFAULT_MAX_TOOL_STEPS, runLlmStream, runLlmTextWithTools } from '../dispatch';
import { LlmCallMeter } from '../requestMeter';
import { taskPolicy, TASK_POLICIES } from '../taskPolicy';
import { toolRoundLimit } from '../taskLimits';
import { scriptedStreamModel, type ScriptedStep } from './streamModel.testlib';

const lookup = tool({
	description: 'look something up',
	inputSchema: z.object({ q: z.string() }),
	execute: async () => 'found',
});

/** A model that asks for the tool on every step, for as many steps as it is given. */
const alwaysCallsTheTool = (steps: number): ScriptedStep[] =>
	Array.from({ length: steps }, () => ({ toolCall: { toolName: 'lookup', input: { q: 'x' } } }));

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCallingGenerateModel(): MockLanguageModelV3 {
	let call = 0;
	return new MockLanguageModelV3({
		modelId: 'scripted-model',
		doGenerate: async () => {
			call += 1;
			return {
				content: [
					{ type: 'tool-call', toolCallId: `c${call}`, toolName: 'lookup', input: '{"q":"x"}' },
				],
				finishReason: { unified: 'tool-calls', raw: undefined },
				usage,
				warnings: [],
			};
		},
	});
}

describe('toolRoundLimit', () => {
	it('caps the caller’s limit at the task’s tool rounds, and leaves an uncapped task alone', () => {
		expect(toolRoundLimit('assistant.answer', 50)).toBe(8);
		expect(toolRoundLimit('assistant.answer', 3)).toBe(3);
		expect(toolRoundLimit('mail.draft', 50)).toBe(50);
		expect(toolRoundLimit(undefined, 50)).toBe(50);
	});

	it('keeps the assistant turn at the step limit it ran with before the catalog', () => {
		expect(taskPolicy('assistant.answer').maxToolRounds).toBe(DEFAULT_MAX_TOOL_STEPS);
		expect(taskPolicy('assistant.answer').maxRetrievalCalls).toBe(DEFAULT_MAX_TOOL_STEPS);
	});

	it('caps only the assistant turn today: every other task keeps its caller’s limits', () => {
		const capped = Object.values(TASK_POLICIES)
			.filter((entry) => entry.maxToolRounds !== null || entry.maxRetrievalCalls !== null)
			.map((entry) => entry.task);
		expect(capped).toEqual(['assistant.answer']);
	});
});

describe('the dispatch stops a tool loop at the task’s rounds', () => {
	it('stream: an assistant turn asking for 50 steps makes 8 requests', async () => {
		const model = scriptedStreamModel(alwaysCallsTheTool(50));
		const meter = new LlmCallMeter({ task: 'assistant.answer' });
		await runLlmStream({
			model,
			messages: [{ role: 'user', content: 'hi' }],
			tools: { lookup },
			maxSteps: 50,
			meter,
		});
		expect(model.doStreamCalls).toHaveLength(8);
		expect(meter.requests).toHaveLength(8);
	});

	it('stream: an uncapped task keeps the caller’s limit', async () => {
		const model = scriptedStreamModel(alwaysCallsTheTool(50));
		await runLlmStream({
			model,
			messages: [{ role: 'user', content: 'hi' }],
			tools: { lookup },
			maxSteps: 10,
			meter: new LlmCallMeter({ task: 'mail.compose' }),
		});
		expect(model.doStreamCalls).toHaveLength(10);
	});

	it('tool loop: the same cap applies to a non-streamed loop of the task', async () => {
		const model = toolCallingGenerateModel();
		await runLlmTextWithTools({
			model,
			messages: [{ role: 'user', content: 'hi' }],
			tools: { lookup },
			maxSteps: 50,
			meter: new LlmCallMeter({ task: 'assistant.answer' }),
		});
		expect(model.doGenerateCalls).toHaveLength(8);
	});
});
