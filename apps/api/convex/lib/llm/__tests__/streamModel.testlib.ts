/**
 * A scripted streaming model for tests that drive the real AI SDK `streamText`
 * loop: each step streams its text chunks and may end in a structured tool
 * call, which the SDK executes before it asks the model for the next step.
 */

import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

type StreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

export interface ScriptedStep {
	/** Text chunks, in order. */
	readonly text?: readonly string[];
	/** A structured tool call after the text; the step then finishes with `tool-calls`. */
	readonly toolCall?: { readonly toolName: string; readonly input: Record<string, unknown> };
}

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function stepStream(step: ScriptedStep, index: number): StreamResult {
	const chunks: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
	if (step.text && step.text.length > 0) {
		const id = `text-${index}`;
		chunks.push({ type: 'text-start', id });
		for (const delta of step.text) chunks.push({ type: 'text-delta', id, delta });
		chunks.push({ type: 'text-end', id });
	}
	if (step.toolCall) {
		chunks.push({
			type: 'tool-call',
			toolCallId: `call-${index}`,
			toolName: step.toolCall.toolName,
			input: JSON.stringify(step.toolCall.input),
		});
	}
	chunks.push({
		type: 'finish',
		finishReason: { unified: step.toolCall ? 'tool-calls' : 'stop', raw: undefined },
		usage: USAGE,
	});
	return { stream: simulateReadableStream({ chunks }) };
}

/**
 * A model whose n-th stream call plays the n-th step. (The mock's own array
 * form reads the entry after the one for the current call.)
 */
export function scriptedStreamModel(steps: readonly ScriptedStep[]): MockLanguageModelV3 {
	let calls = 0;
	return new MockLanguageModelV3({
		modelId: 'scripted-model',
		doStream: async () => {
			const step = steps[calls];
			if (!step) throw new Error(`scripted model has no step ${calls + 1}`);
			calls += 1;
			return stepStream(step, calls);
		},
	});
}
