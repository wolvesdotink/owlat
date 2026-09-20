/**
 * Shared Convex validators for the pluggable AI-providers config table.
 *
 * The language / embedding / decision provider-kind unions are DERIVED from the
 * adapter registries' runtime kind tuples (`lib/llmProviders/types` and
 * `lib/decisionProviders/types`) so the stored `aiProviderConfig` shape and the
 * registries stay a single source of truth — adding a provider adapter widens
 * both at once. Kept in this pure (no `'use node'`) module so both
 * `schema/instance.ts` and the config functions (v8 + Node) can import it
 * without pulling in `node:crypto` or the AI SDK. That is also why the decision
 * kinds are imported from `decisionProviders/types` rather than from that
 * registry's `index.ts`, which reaches its Node-only adapter files.
 */

import { v, type Validator } from 'convex/values';
import {
	EMBEDDING_PROVIDER_KINDS,
	LANGUAGE_ENDPOINT_PROVENANCES,
	LANGUAGE_PROVIDER_KINDS,
	type EmbeddingProviderKind,
	type LanguageEndpointProvenance,
	type LanguageProviderKind,
} from './llmProviders/types';
import { DECISION_PROVIDER_KINDS, type DecisionProviderKind } from './decisionProviders/types';

/** Secret-free endpoint identity used by hard-budget admission accounting. */
export const languageEndpointProvenanceValidator = v.union(
	...LANGUAGE_ENDPOINT_PROVENANCES.map((provenance) => v.literal(provenance))
) as unknown as Validator<LanguageEndpointProvenance>;

/**
 * Stored language-provider kind — every registered language adapter (hosted
 * OpenAI / Anthropic / Google / OpenRouter, plus the local OpenAI-compatible
 * adapter). The variadic spread loses literal narrowing, so we cast back to the
 * registry's `LanguageProviderKind` once here (mirrors `auditActions/catalog`).
 */
export const languageProviderKindValidator = v.union(
	...LANGUAGE_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<LanguageProviderKind>;

/**
 * Stored embedding-provider kind — every registered embedding adapter. The
 * embedding plane is LOCAL BY DEFAULT: `'local'` is the first registered kind
 * (a local embedder resolved INDEPENDENTLY of the language provider), alongside
 * the optional hosted overrides (`openai` / `google`) and a custom
 * `openaiCompatible` server. Derived from the registry's kind tuple so the
 * stored shape and the adapter registry stay a single source of truth. Retained
 * as a named alias (rather than inlining `EmbeddingProviderKind`) so call sites
 * read as "the kind as stored on `aiProviderConfig`".
 */
export type StoredEmbeddingProviderKind = EmbeddingProviderKind;
export const embeddingProviderKindValidator = v.union(
	...EMBEDDING_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<StoredEmbeddingProviderKind>;

/**
 * Stored decision-provider kind — the THIRD plane (typed questions in, typed
 * answers with their probabilities out). Every column of that plane is optional
 * on the row, so an install that never chose one stores nothing here and
 * resolves to `DEFAULT_DECISION_KIND` ('llm'), which is exactly its behaviour
 * before the plane existed. Derived from the registry's kind tuple, like its two
 * neighbours above.
 */
export const decisionProviderKindValidator = v.union(
	...DECISION_PROVIDER_KINDS.map((kind) => v.literal(kind))
) as unknown as Validator<DecisionProviderKind>;
