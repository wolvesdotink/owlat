/**
 * The most output (reasoning included) a model accepts in one request, so a
 * task's output ceiling (`./taskPolicy.ts`) is never sent above what the model
 * supports: a provider refuses a request whose `max_tokens` exceeds the
 * model's maximum (gpt-4o: 16 384), and the ceiling would break a working
 * route instead of bounding it.
 *
 * Matched most-specific-first on the model id without a provider prefix
 * (`anthropic/claude-sonnet-5.5` reads as `claude-sonnet-5.5`). The values are
 * the documented maxima or below them; a lower value only makes the clamp
 * tighter. A model not listed (an Azure deployment name, a local model, a
 * custom endpoint) gets {@link DEFAULT_MODEL_MAX_OUTPUT_TOKENS}, a value every
 * chat model in use accepts.
 *
 * Pure and runtime-neutral.
 */

/** What an unknown model is assumed to accept: every chat model in use takes 4 096. */
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 4_096;

const MODEL_MAX_OUTPUT: readonly { readonly prefix: string; readonly maxOutputTokens: number }[] = [
	// OpenAI
	{ prefix: 'gpt-6', maxOutputTokens: 128_000 },
	{ prefix: 'gpt-5', maxOutputTokens: 128_000 },
	{ prefix: 'gpt-4.1', maxOutputTokens: 32_768 },
	{ prefix: 'gpt-4o', maxOutputTokens: 16_384 },
	{ prefix: 'o4-mini', maxOutputTokens: 100_000 },
	{ prefix: 'o3-mini', maxOutputTokens: 100_000 },
	// Anthropic: the 3.x generation is small; later generations take 32k or more.
	{ prefix: 'claude-3-5', maxOutputTokens: 8_192 },
	{ prefix: 'claude-3', maxOutputTokens: 4_096 },
	{ prefix: 'claude-', maxOutputTokens: 32_000 },
	// Google
	{ prefix: 'gemini-1.5', maxOutputTokens: 8_192 },
	{ prefix: 'gemini-2.0', maxOutputTokens: 8_192 },
	{ prefix: 'gemini-', maxOutputTokens: 65_536 },
	// OpenRouter upstreams
	{ prefix: 'deepseek-', maxOutputTokens: 8_192 },
	{ prefix: 'kimi-', maxOutputTokens: 16_384 },
	{ prefix: 'minimax-', maxOutputTokens: 16_384 },
	{ prefix: 'mimo-', maxOutputTokens: 16_384 },
];

/** The output maximum of `modelId`, or the safe default when the model is unknown. */
export function modelMaxOutputTokens(modelId: string | undefined): number {
	const id = (modelId ?? '').toLowerCase().replace(/^[^/]+\//, '');
	const match = MODEL_MAX_OUTPUT.find((entry) => id.startsWith(entry.prefix));
	return match?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
}
