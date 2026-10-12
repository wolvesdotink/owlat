/**
 * The secret-free endpoint identity of a resolved model, for the ledger's
 * `endpoint` column (ADR-0073): a `LanguageEndpointProvenance` for a language
 * model, `embedding:<provider kind>` for an embedding model. The resolver
 * (`lib/llmProvider.ts`) knows the identity when it builds a model and every
 * call site only holds the model it got back, so the resolver stamps the model
 * object here and the dispatch reads the stamp when it records a request. A
 * weak map keyed by the model object: metadata about one object, not request
 * context, and it never keeps a model alive.
 *
 * Pure and runtime-neutral.
 */

const ENDPOINTS = new WeakMap<object, string>();

/** Record the endpoint identity of a model the resolver built. Returns the model. */
export function stampModelEndpoint<M>(model: M, endpoint: string): M {
	if (typeof model === 'object' && model !== null) ENDPOINTS.set(model, endpoint);
	return model;
}

/** The endpoint identity the resolver stamped on `model`, if any. */
export function modelEndpoint(model: unknown): string | undefined {
	return typeof model === 'object' && model !== null ? ENDPOINTS.get(model) : undefined;
}
