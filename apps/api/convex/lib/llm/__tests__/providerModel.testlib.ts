import type { MockLanguageModelV3 } from 'ai/test';

type ProviderGenerationResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;

export function providerGenerationResult(
	response: unknown,
	text = 'generated text'
): ProviderGenerationResult {
	return {
		content: [{ type: 'text', text }],
		finishReason: { unified: 'stop', raw: undefined },
		usage: {
			inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 5, text: 5, reasoning: undefined },
		},
		warnings: [],
		response: response as ProviderGenerationResult['response'],
	};
}
