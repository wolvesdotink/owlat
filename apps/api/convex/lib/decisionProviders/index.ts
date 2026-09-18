/**
 * Decision provider adapter (module) — registry + dispatch.
 *
 * Mirrors `lib/llmProviders/index.ts` (and through it `lib/sendProviders`,
 * ADR-0020). One plane, one registry: `decisionProviderFor(kind)`.
 *
 * Adding a provider is a one-adapter-file + one-registry-line change; the
 * compile-time mapped-type `satisfies` guard catches a missing or mismatched
 * method. No caller imports an adapter directly — the resolver in
 * `lib/decisionProvider.ts` looks the adapter up by kind and asks through it,
 * and call sites see only `runDecision` and their own question set.
 */

import { typesafeDecisionAdapter } from './typesafe';
import { llmDecisionAdapter } from './llm';
import type { DecisionProviderAdapter, DecisionProviderKind } from './types';

export type {
	DecisionAllowance,
	DecisionEndpointProvenance,
	DecisionProviderAdapter,
	DecisionProviderKind,
	DecisionRequest,
	DecisionResult,
	DecisionState,
	DecisionStateValue,
} from './types';
export {
	DECISION_ENDPOINT_PROVENANCES,
	DECISION_PROVIDER_KINDS,
	DEFAULT_DECISION_KIND,
	classifyStoredDecisionEndpoint,
} from './types';

// ─── Decision registry ─────────────────────────────────────────────────────

export const DECISION_PROVIDERS = {
	typesafe: typesafeDecisionAdapter,
	llm: llmDecisionAdapter,
} as const;

// Compile-time guard: each registry value must satisfy the adapter shape for
// its own kind. The mapped type pins each key to `Adapter<thatKey>`.
const _decisionTypecheck: { [K in DecisionProviderKind]: DecisionProviderAdapter<K> } =
	DECISION_PROVIDERS;
void _decisionTypecheck;

/**
 * Look up the decision adapter for a kind. Throws on unknown kinds — callers
 * validate the kind as a literal union before this is called.
 */
export function decisionProviderFor<K extends DecisionProviderKind>(
	kind: K
): DecisionProviderAdapter<K> {
	const adapter = DECISION_PROVIDERS[kind];
	if (!adapter) {
		throw new Error(`Unknown decision provider: ${kind}`);
	}
	return adapter as unknown as DecisionProviderAdapter<K>;
}
