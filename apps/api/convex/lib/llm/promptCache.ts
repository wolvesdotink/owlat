/**
 * Prompt-cache breakpoints for the STABLE prefix of an LLM call.
 *
 * Every inbound draft re-sends the same large, stable prefix — the system
 * prompt plus the org's tone / signature / voice grounding — ahead of the tiny,
 * per-message part. Marking that prefix as a cache breakpoint lets a provider
 * that supports prompt caching (Anthropic's `cache_control`) serve the prefix
 * from cache on repeat calls, cutting input-token cost and latency (which is
 * what makes "the reply is already waiting" feel instant).
 *
 * Reachability through the existing single-client seam: the AI SDK routes cache
 * breakpoints via a message's `providerOptions.anthropic.cacheControl`. Providers
 * that don't support it — OpenAI / OpenAI-compatible endpoints, which the current
 * `lib/llmProvider` client speaks — cache long prefixes automatically and simply
 * ignore this namespaced option. Attaching it is therefore a safe no-op there, so
 * the SAME message shape works across providers and caching failure degrades to
 * today's single-tier, uncached behaviour (FAIL-SOFT). No provider-specific
 * router is needed; the marker travels as pass-through provider options.
 *
 * Pure module (no `'use node'`, no runtime `ai` import) so it is unit-testable
 * without the AI SDK / a live model.
 */

/**
 * Provider options that mark the message they sit on as a prompt-cache
 * breakpoint. `ephemeral` is Anthropic's short-lived (5-minute) cache tier —
 * the right fit for a prefix reused across a burst of inbound drafts.
 */
type CacheBreakpointProviderOptions = {
	anthropic: { cacheControl: { type: 'ephemeral' } };
};

export const cacheBreakpointProviderOptions: CacheBreakpointProviderOptions = {
	anthropic: { cacheControl: { type: 'ephemeral' } },
};

/** A `system` message whose (stable) content is a prompt-cache breakpoint. */
export type CacheableSystemMessage = {
	role: 'system';
	content: string;
	providerOptions: CacheBreakpointProviderOptions;
};

/**
 * Build a `system` message carrying the given STABLE prefix and marking it as a
 * cache breakpoint. Pass ONLY content that is stable across calls (system
 * prompt, org tone/signature, reusable grounding) — never per-message data,
 * which would defeat the cache by changing the cached prefix on every call.
 */
export function cacheableSystemMessage(content: string): CacheableSystemMessage {
	return { role: 'system', content, providerOptions: cacheBreakpointProviderOptions };
}

// ── L9: cache markers per task (AI routing plan) ──────────────────────────

/** A prompt split into its stable instructions and the per-message content. */
export interface PromptParts {
	/** Identical across calls of one task (and one deployment's languages). */
	stable: string;
	/** The message and its thread state: different every call. */
	variable: string;
}

/** The prompt exactly as a single string, the shape every call sends today. */
export function joinPromptParts(parts: PromptParts): string {
	return `${parts.stable}\n\n${parts.variable}`;
}

/**
 * Whether a call carries a cache marker: its task is on the routing policy's
 * `promptCacheTasks` list (empty by default) AND the model is served by the
 * native Anthropic adapter, the only transport where the marker is known to
 * take effect. OpenRouter and the OpenAI-shaped adapters never get one: their
 * caching, where it exists, is automatic, and the Anthropic marker is not
 * assumed to pass through them. Pure.
 */
export function isPromptCacheMarked(
	model: unknown,
	task: string,
	cacheTasks: readonly string[]
): boolean {
	if (!cacheTasks.includes(task)) return false;
	if (typeof model !== 'object' || model === null || !('provider' in model)) return false;
	const provider = (model as { provider: unknown }).provider;
	return typeof provider === 'string' && provider.startsWith('anthropic.');
}

/**
 * The dispatch input for a split prompt. Unmarked, it is the joined prompt,
 * byte for byte what the call sent before the split. Marked, the stable part
 * becomes a cache-breakpoint system message and the per-message part the user
 * message. Never padded: a prefix under the provider's minimum is simply not
 * cached.
 */
export function promptInputOf(
	parts: PromptParts,
	isMarked: boolean
): { prompt: string } | { messages: [CacheableSystemMessage, { role: 'user'; content: string }] } {
	if (!isMarked) return { prompt: joinPromptParts(parts) };
	return {
		messages: [cacheableSystemMessage(parts.stable), { role: 'user', content: parts.variable }],
	};
}
