/**
 * Decision provider adapter (module) — shared types.
 *
 * A THIRD plane beside the two in `lib/llmProviders` (per the 2026-09-17
 * decision-plane plan):
 *
 *   • LANGUAGE plane — everything that writes. AI-SDK `LanguageModel` based.
 *   • EMBEDDING plane — retrieval. Local by default so it resolves under any
 *     language choice.
 *   • DECISION plane — typed questions in, typed answers with their probability
 *     distributions out. Nothing here writes a word of text.
 *
 * The decision plane is its own plane rather than a language provider because
 * the provider it was built for is not an AI-SDK `LanguageModel`, and wrapping
 * it in `generateObject` would throw away the probabilities — which are the
 * entire reason to use it.
 *
 * "Built like its neighbours" is a deliberate choice, not a copy: the adapter
 * follows the LANGUAGE shape (kind, label, docsUrl, optional base URL,
 * credential validation, optional model discovery) MINUS the fast/capable
 * tiers, because a decision provider has one model. It adds two properties the
 * other planes have no use for: `calibrated`, which every threshold downstream
 * reads before it trusts a number, and the endpoint provenance stamped onto the
 * result.
 *
 * The registry (`./index.ts`) mirrors `lib/llmProviders/index.ts` and
 * `lib/sendProviders` (ADR-0020): a `Kind` literal union plus a mapped-type
 * `satisfies` guard, so each provider supplies an adapter and registers its kind; callers stay generic.
 *
 * This file is pure and isolate-safe: `schema/instance.ts` reaches the decision
 * kinds through the validators, so nothing in this chain may import
 * `node:crypto`, `@ai-sdk/*` or `convex/server`. Every call site that will use
 * the plane is already `'use node'`, so isolate-safety here is about the schema
 * chain, not the callers.
 */

import type { EnvKey } from '../env';
import type { TokenUsage } from '../../agent/steps/types';
import type { ProviderClientConfig } from '../llmProviders/types';
import type { AnswersFor, QuestionSet } from '../decision/questions';

/**
 * The decision provider kinds, as a runtime tuple so both the
 * `DecisionProviderKind` type and the registry's completeness guard derive from
 * one source. Two adapters today: `typesafe` (the native decision API — one
 * model, calibrated probabilities, charged on input tokens only) and `llm`
 * (the same question sets rendered onto the existing LANGUAGE plane, returning
 * degenerate probabilities and `calibrated: false`).
 *
 * `llm` is not a stub. It is the path every install WITHOUT a decision key
 * runs — which is what makes the plane revertible by a dropdown, and what makes
 * "no key entered" mean "exactly today's behaviour".
 */
export const DECISION_PROVIDER_KINDS = ['typesafe', 'llm'] as const;
export type DecisionProviderKind = (typeof DECISION_PROVIDER_KINDS)[number];

/**
 * What an install with no decision key resolves to: the language plane, which
 * is exactly today's behaviour. `typesafe` is the RECOMMENDED adapter and the
 * one preselected in the picker for a brand-new decision config — it is not
 * what an unconfigured or upgraded deployment falls into. Nothing leaves a
 * deployment until an operator enters their own key.
 */
export const DEFAULT_DECISION_KIND = 'llm' satisfies DecisionProviderKind;

/**
 * Secret-free identity of the endpoint that answered a decision. The native
 * identity is assigned only when the registered provider used its built-in
 * endpoint; any explicit base URL or proxy is `custom` and cannot use
 * list-price admission. `llm-backed` says the answer came off the language
 * plane, whose own provenance is tracked separately by that plane.
 */
export const DECISION_ENDPOINT_PROVENANCES = ['typesafe-native', 'llm-backed', 'custom'] as const;
export type DecisionEndpointProvenance = (typeof DECISION_ENDPOINT_PROVENANCES)[number];

/**
 * A JSON value the state may be built from. The provider is TEXT ONLY — no
 * images, audio or video — and reads dates as text, so callers pass redacted,
 * budget-capped text or plain data, never an attachment and never a number they
 * intend to have compared.
 */
export type DecisionStateValue =
	| string
	| number
	| boolean
	| null
	| readonly DecisionStateValue[]
	| { readonly [key: string]: DecisionStateValue };

/** The state a question set is answered against: a string, an array or an object. */
export type DecisionState =
	| string
	| readonly DecisionStateValue[]
	| { readonly [key: string]: DecisionStateValue };

/**
 * One round trip: a state plus the questions asked about it. Batching is the
 * point — thirteen questions in one call measured an order of magnitude faster
 * than the same thirteen sent separately.
 *
 * Both cancellation handles are optional at this layer and the dispatch
 * supplies them: `deadlineMs` is the plane's own budget (a plane selling
 * sub-second answers must not inherit an unbounded socket) and `abortSignal`
 * carries a caller's cancellation into the adapter's fetch.
 */
export interface DecisionRequest<Q extends QuestionSet = QuestionSet> {
	readonly state: DecisionState;
	readonly questions: Q;
	readonly abortSignal?: AbortSignal;
	readonly deadlineMs?: number;
	/**
	 * The model id the resolver settled on (stored column, then `DECISION_MODEL`,
	 * then the adapter's own default). Absent means "the adapter's default", which
	 * is the pinned version — the settings picker and the env variable exist so an
	 * operator can name a version deliberately, and an id that is stored, shown
	 * back and then not sent is the worst of both.
	 */
	readonly modelId?: string;
}

/**
 * One answer per requested question, plus everything an accounting row and a
 * threshold need. `calibrated` is the single value a call site is allowed to
 * read off an adapter's behaviour: a calibrated probability is a better input
 * to a gate than a self-reported one, and an uncalibrated one must not be
 * thresholded as though it were. Note calibration is a property of a GROUP of
 * predictions and never a guarantee about an individual answer.
 */
export interface DecisionResult<Q extends QuestionSet = QuestionSet> {
	readonly answers: AnswersFor<Q>;
	/** Billed usage. Output tokens are returned and counted even where they cost nothing. */
	readonly usage: TokenUsage;
	/** The model id the provider reported answering with, never the one we requested. */
	readonly modelUsed: string;
	readonly provenance: DecisionEndpointProvenance;
	readonly calibrated: boolean;
}

/**
 * The gate's answer, carried into the dispatch.
 *
 * `decision/gate.ts` enforces the `ai.decisionPlane` kill switch and the
 * instance-global rate limit in a MUTATION, because an action has no `ctx.db`
 * and cannot read a feature flag at all. `runDecision` then requires one of
 * these, so a call site cannot reach the plane without having run that check in
 * the same request — the flag is structurally in the path rather than in the
 * caller's good manners. `fallbackAllowed` is the breaker's verdict as of the
 * gate; the dispatch asks the breaker again before it actually hops.
 */
export interface DecisionAllowance {
	readonly allowed: true;
	readonly fallbackAllowed: boolean;
}

/**
 * Decision provider adapter. One file per provider; the `kind` narrows the
 * registry's mapped-type guard so a missing or mismatched method is a compile
 * error. `ask` is the only call-time surface the dispatch uses;
 * `validateCredentials` fails fast on incomplete config; `listModels` is an
 * optional discovery hook.
 *
 * `ask` is deliberately NOT generic: an adapter owns transport and validation,
 * not the caller's key narrowing. `runDecision` re-narrows the result to the
 * caller's own question set, which is the one place the cast is written.
 *
 * No call site imports an adapter. Call sites import `runDecision` and their
 * own question set.
 */
export interface DecisionProviderAdapter<K extends DecisionProviderKind = DecisionProviderKind> {
	readonly kind: K;
	/** Human label for the settings UI. */
	readonly label: string;
	/** Where to point an operator to get / configure credentials. */
	readonly docsUrl: string;
	/** Default base URL for this provider, if any. */
	readonly defaultBaseUrl?: string;
	/** The single model id used when none is configured. Pinned, never an alias. */
	readonly defaultModel: string;
	/**
	 * True when this provider's probabilities are calibrated across groups of
	 * predictions. Stamped onto every result: thresholds go inert without it and
	 * the settings card says so in words.
	 */
	readonly calibrated: boolean;
	/** True for locally-hosted providers (keyless, base-URL driven). */
	readonly isLocal: boolean;
	/** Credential requirements are independent of whether inference is local. */
	readonly requiresApiKey: boolean;
	readonly apiKeyEnv?: EnvKey;
	/** Each provider owns its latency budget and retry implementation. */
	readonly defaultDeadlineMs: number;
	/** Use custom until this endpoint has an explicitly trusted price catalog. */
	readonly defaultEndpointProvenance: DecisionEndpointProvenance;
	readonly handlesRetries: boolean;
	/** Answer a question set. Rejects rather than coercing a disagreeing response. */
	ask(cfg: ProviderClientConfig, req: DecisionRequest): Promise<DecisionResult>;
	/** Throw a descriptive error when `cfg` can't produce a working client. */
	validateCredentials(cfg: ProviderClientConfig): void;
	/** Optional: list the model ids the provider exposes for this config. */
	listModels?(cfg: ProviderClientConfig): Promise<string[]>;
}
