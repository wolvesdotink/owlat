/**
 * Decision plane — the dispatch CONTRACT.
 *
 * The shapes `runDecision` is called with and answers in, and the three ports it
 * is given instead of a Convex ctx: the usage recorder, the rate limiter and the
 * fallback breaker. Two of the three have a ctx-bound implementation today; see
 * the header of `./ports.ts` for why the attempt limiter is named there and not
 * yet built. They live beside the dispatch rather than inside it because
 * `./dispatch.ts` is `'use node'` (it reaches the adapters, and through them the
 * AI SDK) while a contract is nothing but types — a call site, a test fake or a
 * ctx-bound port builder can read this file without pulling a Node runtime in
 * behind it. `./dispatch.ts` re-exports every name here, so a caller still has
 * one import.
 *
 * The one behaviour in the file is {@link DecisionRateLimitRefusal}, and it is
 * here for the same reason: it is part of the contract that OUR ceiling refusing
 * a call is terminal, not a provider failure to be retried, charged to the
 * breaker, or answered on a model that costs 24 to 50 times more.
 */

import type { LanguageModel } from 'ai';
import type { TokenUsage } from '../../agent/steps/types';
import type {
	DecisionAllowance,
	DecisionEndpointProvenance,
	DecisionProviderKind,
	DecisionResult,
	DecisionState,
} from '../decisionProviders/types';
import type { ProviderClientConfig } from '../llmProviders/types';
import type { QuestionSet } from './questions';

/**
 * A decision plane resolved from stored config: which adapter, the secret-bearing
 * client config it builds from, and — for the language-backed adapter — the
 * `LanguageModel` the LANGUAGE plane already resolved. Resolving a model here
 * would give the deployment two answers to "which model writes", so
 * `lib/decisionProvider.ts` resolves both and hands them over.
 */
export interface ResolvedDecisionProvider {
	readonly kind: DecisionProviderKind;
	readonly config: ProviderClientConfig;
	/** Required for `kind: 'llm'`; ignored by the native adapter. */
	readonly model?: LanguageModel;
	/**
	 * The model id the resolver settled on, passed through to the adapter.
	 * Absent ⇒ the adapter's own pinned default. The language-backed adapter has
	 * none of its own: the LANGUAGE plane owns that answer.
	 */
	readonly modelId?: string;
	/** Per-plane override; otherwise the adapter's default deadline applies. */
	readonly deadlineMs?: number;
}

/**
 * One attempt, as the accounting sees it. The recorder fires EXACTLY ONCE per
 * attempt — failed ones and the fallback hop included — so the enforced ceiling
 * counts what was spent rather than what was returned, and `requestId` is
 * stable across one logical call, so a recorder can tell three rows of one
 * retried decision from three decisions.
 */
export interface DecisionAttemptRecord {
	/** The caller's tag, as `analytics/llmUsage.ts` spells `feature`. */
	readonly feature: string;
	readonly requestId: string;
	readonly provider: DecisionProviderKind;
	/** 1-based within this provider; the hop restarts at 1, under `fallback: true`. */
	readonly attempt: number;
	readonly fallback: boolean;
	readonly outcome: 'answered' | 'failed';
	readonly durationMs: number;
	/** Present on answered calls and billed responses rejected by the codec. */
	readonly usage?: TokenUsage;
	readonly modelUsed?: string;
	readonly provenance?: DecisionEndpointProvenance;
	readonly calibrated?: boolean;
	/**
	 * Present on `failed`. Adapters redact their key out of everything they throw
	 * before it gets here; a recorder that persists this must not undo that by
	 * storing a raw cause chain.
	 */
	readonly error?: unknown;
}

/**
 * Where a decision's spend is written. Injected rather than imported: the write
 * needs a Convex ctx, and the row must land BEFORE the answer is used so the
 * enforced ceiling sees it. A recorder that throws on a SUCCESSFUL attempt
 * therefore ends the call without retry or fallback; on a failed one it is swallowed.
 */
export type DecisionUsageRecorder = (record: DecisionAttemptRecord) => void | Promise<void>;

/** Persistence failed after the provider answered. Never retry the provider or hop. */
export class DecisionAccountingFailure extends Error {
	constructor(cause: unknown) {
		super('Decision usage could not be recorded.', { cause });
		this.name = 'DecisionAccountingFailure';
	}
}

/** An attempt limiter, injected. Consumed once per ATTEMPT, since an attempt is
 * a request upstream — which is what makes it a different reading from the one
 * `decision/gate.ts` takes on `decisionPlaneGlobal`, one token per LOGICAL call
 * at admission. Nothing injects one yet (see `./ports.ts`). Throw (or reject) to refuse — a
 * refusal is a hard stop, not a retriable failure, and the dispatch enforces
 * that by wrapping whatever is thrown in {@link DecisionRateLimitRefusal}. */
export interface DecisionRateLimiter {
	reserve(provider: DecisionProviderKind): void | Promise<void>;
}

/**
 * OUR OWN limiter said no. Distinct from every provider failure, and terminal:
 * not retried (the bucket the retry would hit is the empty one), never charged
 * to the breaker (the decision provider did nothing wrong, and charging it would
 * let a busy minute report the plane as failing and refuse the hop for the next
 * five), and never a reason to hop onto a model that costs 24 to 50 times more —
 * paying for volume we just refused to serve is the one response nobody wants.
 */
export class DecisionRateLimitRefusal extends Error {
	constructor(provider: DecisionProviderKind, options: { cause?: unknown } = {}) {
		super(
			`The decision plane's rate limit refused a ${provider} call. ` +
				'This is our own ceiling, not the provider — the call is not retried.',
			options.cause === undefined ? undefined : { cause: options.cause }
		);
		this.name = 'DecisionRateLimitRefusal';
	}
}

/**
 * The breaker guarding the fallback hop, modelled on the `llm_failure` breaker
 * beside `agentHealth.ts`. Open means "the decision plane has been failing, so
 * the hop is off": a vendor outage must not silently re-route every inbound
 * message onto a model that costs 24 to 50 times more. Only the PRIMARY plane's
 * outcomes are reported; the hop's failures are the language plane's signal.
 */
export interface DecisionFallbackBreaker {
	isOpen(): boolean | Promise<boolean>;
	recordFailure(): void | Promise<void>;
}

export interface RunDecisionOptions<Q extends QuestionSet> {
	/** Accounting tag for every attempt this call makes. */
	readonly feature: string;
	readonly state: DecisionState;
	readonly questions: Q;
	readonly provider: ResolvedDecisionProvider;
	/**
	 * The gate's answer, from `internal.decision.gate.assertDecisionAllowed`, run
	 * in the same request. Required: the kill switch and the instance-global
	 * bucket live in a mutation an action cannot inline, and making their verdict
	 * an ARGUMENT is what stops a call site from reaching the vendor without them.
	 */
	readonly allowance: DecisionAllowance;
	/**
	 * The resolved LANGUAGE plane to hop onto, once, if the primary fails a
	 * fallback-eligible way. ABSENT MEANS NO HOP — the default, and what "off for
	 * the high-volume background classifiers" compiles down to. Must be
	 * `kind: 'llm'`, must carry its model, and must travel with a `breaker` and a
	 * `recordUsage`: an uncapped, unrecorded hop is the one shape of this feature
	 * that can cost real money.
	 */
	readonly fallbackTo?: ResolvedDecisionProvider;
	/** Cancels the in-flight request and the backoff between attempts. */
	readonly abortSignal?: AbortSignal;
	/** Overrides the plane's and the adapter's default deadline. */
	readonly deadlineMs?: number;
	/** Attempts on the PRIMARY plane. Defaults to {@link DEFAULT_DECISION_ATTEMPTS}. */
	readonly maxAttempts?: number;
	/**
	 * Stable id for this logical call, carried across retries and the hop. Pass
	 * one derived from the work item (a message id, say) to de-duplicate a re-run
	 * of the same work too; otherwise a UUID is generated per call.
	 */
	readonly requestId?: string;
	readonly recordUsage?: DecisionUsageRecorder;
	readonly rateLimiter?: DecisionRateLimiter;
	readonly breaker?: DecisionFallbackBreaker;
	/** Injected so the jitter is deterministic under test. Defaults to `Math.random`. */
	readonly random?: () => number;
	/** Injected so tests observe the computed backoff without waiting it out. */
	readonly sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

/** A decision, plus how it was arrived at. */
export interface RunDecisionResult<Q extends QuestionSet> extends DecisionResult<Q> {
	/** The adapter that answered — `llm` with `fallback: true` means the hop ran. */
	readonly provider: DecisionProviderKind;
	readonly fallback: boolean;
	readonly requestId: string;
	/** Attempts spent in total, the hop included. */
	readonly attempts: number;
}
