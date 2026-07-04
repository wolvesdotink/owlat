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
export type CacheBreakpointProviderOptions = {
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
