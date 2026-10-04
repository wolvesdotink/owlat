/**
 * `runLlmStream` (lib/llm/dispatch.ts) against the real AI SDK step loop with a
 * scripted model: a document-body caller (`finalStepOnly`) keeps only the text
 * after the last tool call, so narration such as "Let me check availability…"
 * never reaches the draft (#1254); a chat caller keeps the whole transcript.
 */

import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runLlmStream } from '../dispatch';
import { scriptedStreamModel } from './streamModel.testlib';

const NARRATION = 'Let me check availability for those dates.';
const REPLY = 'Hi John,\n\nwe have a room for you.\n\nBest,\nAda';

function recallTool() {
	const execute = vi.fn(async () => ({ facts: [] as string[] }));
	return {
		execute,
		tools: {
			recallKnowledge: tool({
				description: 'Fetch a fact',
				inputSchema: z.object({ query: z.string() }),
				execute,
			}),
		},
	};
}

function narratedToolCallModel() {
	return scriptedStreamModel([
		{
			text: ['Let me check ', 'availability for those dates.'],
			toolCall: { toolName: 'recallKnowledge', input: { query: 'availability' } },
		},
		{ text: ['Hi John,\n\n', 'we have a room for you.', '\n\nBest,\nAda'] },
	]);
}

describe('runLlmStream — finalStepOnly', () => {
	it('drops text written before a real tool call from the result and the live text', async () => {
		const { tools, execute } = recallTool();
		const seen: string[] = [];
		const result = await runLlmStream({
			model: narratedToolCallModel(),
			messages: [{ role: 'user', content: 'Draft a reply.' }],
			tools,
			finalStepOnly: true,
			onTextDelta: (full) => {
				seen.push(full);
			},
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(result.text).toBe(REPLY);
		// The live view drops the narration as soon as the call arrives, and no
		// later text carries it.
		const reset = seen.indexOf('');
		expect(reset).toBeGreaterThan(0);
		expect(seen.slice(0, reset).every((text) => NARRATION.startsWith(text))).toBe(true);
		expect(seen.slice(reset).every((text) => REPLY.startsWith(text))).toBe(true);
		expect(seen[seen.length - 1]).toBe(REPLY);
	});

	it('changes nothing for a single-step reply', async () => {
		const seen: string[] = [];
		const result = await runLlmStream({
			model: scriptedStreamModel([{ text: ['Hi ', 'John'] }]),
			messages: [{ role: 'user', content: 'Draft a reply.' }],
			finalStepOnly: true,
			onTextDelta: (full) => {
				seen.push(full);
			},
		});
		expect(result.text).toBe('Hi John');
		expect(seen).toEqual(['Hi ', 'Hi John']);
	});

	it('keeps the whole transcript for a chat caller', async () => {
		const { tools } = recallTool();
		const seen: string[] = [];
		const result = await runLlmStream({
			model: narratedToolCallModel(),
			messages: [{ role: 'user', content: 'Any rooms?' }],
			tools,
			onTextDelta: (full) => {
				seen.push(full);
			},
		});
		expect(result.text).toBe(NARRATION + REPLY);
		expect(seen).not.toContain('');
	});
});
