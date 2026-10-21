/**
 * The secret-free endpoint identity of a resolved model, for the ledger's
 * `endpoint` column: a `LanguageEndpointProvenance` for a language
 * model, `embedding:<provider kind>` for an embedding model, plus whether the
 * model runs on the operator's own hardware (a local embedder costs nothing).
 * The resolver (`lib/llmProvider.ts`) knows both when it builds a model and
 * every call site only holds the model it got back, so the resolver stamps the
 * model object here and the dispatch reads the stamp when it records a
 * request. A weak map keyed by the model object: metadata about one object,
 * not request context, and it never keeps a model alive.
 *
 * A language model also carries the tier it was resolved on, which the
 * dispatch checks against its call's task (`./callShape.ts`).
 *
 * Pure and runtime-neutral.
 */

import type { LlmTier } from './taskPolicy';

interface ModelStamp {
	readonly endpoint: string;
	readonly isLocal: boolean;
	readonly tier?: LlmTier;
}

const STAMPS = new WeakMap<object, ModelStamp>();

/** Record the endpoint identity of a model the resolver built. Returns the model. */
export function stampModelEndpoint<M>(
	model: M,
	endpoint: string,
	options: { readonly isLocal?: boolean; readonly tier?: LlmTier } = {}
): M {
	if (typeof model === 'object' && model !== null) {
		STAMPS.set(model, {
			endpoint,
			isLocal: options.isLocal === true,
			...(options.tier ? { tier: options.tier } : {}),
		});
	}
	return model;
}

/** The endpoint identity the resolver stamped on `model`, if any. */
export function modelEndpoint(model: unknown): string | undefined {
	return typeof model === 'object' && model !== null ? STAMPS.get(model)?.endpoint : undefined;
}

/** True when the resolver stamped `model` as running on the operator's own hardware. */
export function isLocalModel(model: unknown): boolean {
	return typeof model === 'object' && model !== null && STAMPS.get(model)?.isLocal === true;
}

/** The tier the resolver resolved a language `model` on, if it stamped one. */
export function modelTier(model: unknown): LlmTier | undefined {
	return typeof model === 'object' && model !== null ? STAMPS.get(model)?.tier : undefined;
}
