import type { DatabaseReader } from '../_generated/server';
import { getOptional } from './env';

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

/** The environment's LLM key, under any of the names the resolver accepts. */
export function envLlmApiKey(): string | undefined {
	return (
		getOptional('LLM_API_KEY') || getOptional('OPENROUTER_API_KEY') || getOptional('OPENAI_API_KEY')
	);
}

/**
 * Whether the environment sets up a provider: a key, or the keyless Ollama.
 * `llmProvider.resolveEnvClientConfig` throws {@link AiNotConfiguredError}
 * exactly when this is false.
 */
export function isEnvAiProviderConfigured(): boolean {
	return Boolean(envLlmApiKey()) || getOptional('LLM_PROVIDER') === 'ollama';
}

/**
 * Whether any AI provider is set up, decided like the resolver decides it: a
 * stored `aiProviderConfig` row (Settings → AI; an org singleton, so `first()`
 * reads at most one row), else the environment. Readable from a query or a
 * mutation, where the resolver itself cannot run.
 */
export async function isAiProviderConfigured(db: DatabaseReader): Promise<boolean> {
	return (await hasStoredAiProviderConfig(db)) || isEnvAiProviderConfigured();
}

/** Whether a provider config was saved through Settings → AI. */
export async function hasStoredAiProviderConfig(db: DatabaseReader): Promise<boolean> {
	return (await db.query('aiProviderConfig').first()) !== null;
}
