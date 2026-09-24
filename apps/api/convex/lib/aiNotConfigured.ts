/**
 * Thrown when no AI provider is set up at all: no stored `aiProviderConfig`
 * row and no `LLM_*` key in the environment. AI is optional, so a caller that
 * only enriches data (summaries, embeddings) can treat this as "skip", while a
 * set-up but broken provider still throws its own error.
 */
export class AiNotConfiguredError extends Error {
	constructor() {
		super(
			'LLM API not configured. Set LLM_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in Convex environment variables.'
		);
		this.name = 'AiNotConfiguredError';
	}
}
