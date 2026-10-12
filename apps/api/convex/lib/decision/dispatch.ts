'use node';

/**
 * Decision plane — the dispatch.
 *
 * `runDecision` is the one choke point every call site on this plane goes
 * through, the way `lib/llm/dispatch.ts` is the one seam for the LANGUAGE plane
 * (ADR-0029). Call sites import this function and their own question set; only
 * `lib/decisionProvider.ts` and this file touch an adapter, and the one adapter
 * property a call site may read is `calibrated`.
 *
 * What this file owns, and why each rule is written the way it is:
 *
 *   • DEADLINE. Every request carries one — `fetchGuarded` adds none of its own
 *     and a plane sold on sub-second answers must not inherit an unbounded
 *     socket. The default differs per adapter: one number cannot be both
 *     generous to a chat model and tight for the native endpoint.
 *   • RETRY. Through the repo's one classifier, `isRetriableLlmError`, not a
 *     fork of it. Backoff is exponential, bounded AND JITTERED — the language
 *     plane has no jitter, and one shared upstream bucket plus our synchronized
 *     ingest is the exact shape that turns one 429 into a retry storm. A
 *     `Retry-After` the adapter surfaced replaces our curve.
 *   • ABORT. The caller's signal rides into the adapter (both honour it) and
 *     cancels the backoff between attempts. It is never retried and never falls
 *     back: a cancellation is not a failure of the provider.
 *   • FALLBACK. At most ONE hop to the language-backed adapter, only when the
 *     caller passed a resolved `fallbackTo` plane, never after a 401/403/422
 *     (our key or our question set — falling back would hide that forever),
 *     never after a codec refusal, never while the breaker is open. The hop is a
 *     cost lever an outsider can pull: this path is fed by strangers sending us
 *     email and the model it re-routes onto costs 24 to 50 times more, so
 *     default-off is structural — no `fallbackTo`, no hop.
 *   • PARTIAL OR FOREIGN ANSWERS. Already hard errors in the codec
 *     (`DecisionWireError`), never papered over here: our question set and the
 *     answer disagreeing means re-asking would only corrupt the calibration
 *     statistics every later phase gates on.
 *   • THE KILL SWITCH IS AN ARGUMENT. `runDecision` takes the gate's own answer
 *     ({@link RunDecisionOptions.allowance}), which only
 *     `internal.decision.gate.assertDecisionAllowed` produces, so a call site
 *     cannot reach the vendor without having read the `ai.decisionPlane` flag
 *     and charged the instance-global bucket in the same request. A flag
 *     enforced by convention is a flag that is off everywhere except the one
 *     path somebody forgot.
 *   • IDEMPOTENCY. One client-side request id per LOGICAL call, carried across
 *     every attempt and the hop the way `plugins/llmAccounting.ts` carries a
 *     `reservationId`, and handed to the recorder on every row — so three rows
 *     of one retried decision are identifiable AS one decision rather than
 *     reading as three. The vendor documents no idempotency key of its own, so
 *     this is an accounting handle, not a promise that a retried POST is free.
 *
 * What it deliberately does NOT own: the accounting write, the rate limiter and
 * the breaker are injected (see {@link RunDecisionOptions}), because each of
 * them needs a Convex ctx this module has no business holding — and keeping them
 * out is what lets the contract be tested with fakes. The two whose absence
 * would cost money rather than observability — the breaker and the recorder —
 * are REQUIRED alongside `fallbackTo` rather than defaulted away.
 */

import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { decisionProviderFor } from '../decisionProviders';
import type { DecisionRequest, DecisionResult } from '../decisionProviders/types';
export { DEFAULT_LANGUAGE_DECISION_DEADLINE_MS } from '../decisionProviders/llm';
import { MAX_LLM_ATTEMPTS } from '../llm/retryPolicy';
import { LlmCallMeter } from '../llm/requestMeter';
import {
	attemptRequests,
	billedUsage,
	localTag,
	withinRoot,
	withRootDeadline,
} from './attemptRequests';
export { billedUsage } from './attemptRequests';
import { taskForFeature } from '../llm/taskPolicy';
import { DecisionAccountingFailure, DecisionRateLimitRefusal } from './contract';
import { admissionRefusalOf } from '../llm/admissionPort';
import { admitNativeAttempt, holdSettlements } from './attemptAdmission';
import type {
	DecisionFallbackBreaker,
	DecisionRateLimiter,
	DecisionUsageRecorder,
	ResolvedDecisionProvider,
	RunDecisionOptions,
	RunDecisionResult,
} from './contract';
import type { AnswersFor, QuestionSet } from './questions';

// One import for a call site: the contract next door is re-exported here, so
// nothing downstream has to know the plane's types and its dispatch are two
// files (they are two because this one is `'use node'` and a contract is not).
export {
	DecisionAccountingFailure,
	DecisionProviderUnavailable,
	DecisionRateLimitRefusal,
} from './contract';
export {
	backoffDelayMs,
	DECISION_BACKOFF_BASE_MS,
	isRetriableDecisionError,
	MAX_DECISION_BACKOFF_MS,
	MAX_HONOURED_RETRY_AFTER_MS,
	mayFallBack,
	NO_FALLBACK_STATUSES,
	RETRY_AFTER_JITTER_MS,
} from './retryRules';
import {
	backoffDelayMs,
	isRetriableDecisionError,
	mayFallBack,
	realSleep,
	retryAfterOf,
} from './retryRules';
export type {
	DecisionAttemptRecord,
	DecisionFallbackBreaker,
	DecisionRateLimiter,
	DecisionUsageRecorder,
	ResolvedDecisionProvider,
	RunDecisionOptions,
	RunDecisionResult,
} from './contract';

/** Attempts per logical call, shared with the language plane so one number moves both. */
export const DEFAULT_DECISION_ATTEMPTS = MAX_LLM_ATTEMPTS;

const NO_OP_RATE_LIMITER: DecisionRateLimiter = { reserve: () => {} };

/**
 * The breaker a call with no hop to guard runs under. It can only ever be asked
 * to record a failure — `fallbackTo` without a real breaker is refused below —
 * and a call that cannot hop has no expensive path for a failure budget to
 * protect.
 */
const NO_HOP_BREAKER: DecisionFallbackBreaker = {
	isOpen: () => false,
	recordFailure: () => {},
};

function assertNotAborted(abortSignal: AbortSignal | undefined): void {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('Decision dispatch aborted');
}

function deadlineFor(provider: ResolvedDecisionProvider, override: number | undefined): number {
	const fallbackDefault = decisionProviderFor(provider.kind).defaultDeadlineMs;
	return override ?? provider.deadlineMs ?? fallbackDefault;
}

// ─── One attempt ───────────────────────────────────────────────────────────

/** The request as it leaves the dispatch: `model` is what the language-backed
 * adapter reads instead of a credential, `modelId` the version the resolver
 * settled on, `requestId` the idempotency handle an adapter may put on the wire
 * (the native one ignores it today). */
type DispatchedRequest = DecisionRequest & { requestId: string; model?: LanguageModel };

interface AttemptContext<Q extends QuestionSet> {
	readonly options: RunDecisionOptions<Q>;
	readonly requestId: string;
	readonly recordUsage: DecisionUsageRecorder;
	readonly rateLimiter: DecisionRateLimiter;
	/** Every provider request of the logical call, the hop included, numbered in order. */
	readonly meter: LlmCallMeter;
}

/**
 * One round trip, with its accounting. Success and failure both record exactly
 * once, and the success row is awaited BEFORE the answer is handed back so the
 * ceiling sees the spend before the caller acts on it.
 */
async function askOnce<Q extends QuestionSet>(
	ctx: AttemptContext<Q>,
	provider: ResolvedDecisionProvider,
	attempt: number,
	fallback: boolean
): Promise<DecisionResult> {
	const { options } = ctx;
	// Wrapped, not propagated: whatever a ctx-bound limiter throws (a ConvexError
	// from `throwRateLimited`, say) carries no status, so the shared classifier
	// would read it as an ambiguous network blip and retry it — against the empty
	// bucket that just refused it, and then onto the expensive hop.
	try {
		await ctx.rateLimiter.reserve(provider.kind);
	} catch (error) {
		throw new DecisionRateLimitRefusal(provider.kind, { cause: error });
	}
	const request: DispatchedRequest = {
		state: options.state,
		questions: options.questions,
		deadlineMs: withinRoot(deadlineFor(provider, options.deadlineMs), options.root),
		requestId: ctx.requestId,
		meter: ctx.meter,
		...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
		...(provider.model === undefined ? {} : { model: provider.model }),
		...(provider.modelId ? { modelId: provider.modelId } : {}),
	};
	const startedAt = Date.now();
	const elapsed = () => Date.now() - startedAt;
	const recordedBefore = ctx.meter.requests.length;
	const base = {
		feature: options.feature,
		requestId: ctx.requestId,
		provider: provider.kind,
		attempt,
		fallback,
		...(options.task ? { task: options.task } : {}),
		...(options.root ? { root: options.root } : {}),
	} as const;

	// Spend admission (ADR-0073): a native paid adapter's request is reserved
	// here; the language-backed adapter's are reserved inside its `runLlmObject`.
	const hold = await admitNativeAttempt(ctx.meter, provider, options);
	let result: DecisionResult;
	try {
		result = await decisionProviderFor(provider.kind).ask(provider.config, request);
	} catch (error) {
		// Admission refused a request before it was sent. When that was the
		// attempt's first request nothing was billed, so nothing is recorded; when
		// an adapter's inner retry was refused, the requests it already made are
		// recorded below, and no row is made up for the refused one (Sol r2 F1).
		if (admissionRefusalOf(error) && ctx.meter.requests.length === recordedBefore) {
			await hold.end();
			throw error;
		}
		const durationMs = elapsed();
		const billed = billedUsage(error);
		const requests = attemptRequests(
			ctx.meter,
			recordedBefore,
			{ outcome: 'failed', ...billed },
			durationMs,
			error,
			{ isFallback: fallback, ...localTag(provider) }
		);
		// Closed after the attempt's request is on the meter, so it carries the hold.
		await hold.end();
		const settlements = holdSettlements(ctx.meter);
		try {
			await ctx.recordUsage({
				...base,
				outcome: 'failed',
				durationMs,
				error,
				...billed,
				requests,
				...settlements.args,
			});
			ctx.meter.acknowledge(requests);
			settlements.markSent();
		} catch {
			// Swallowed: a failing recorder must not replace the vendor's error,
			// which is the one the operator needs to read.
		}
		throw error;
	}
	const durationMs = elapsed();
	const requests = attemptRequests(
		ctx.meter,
		recordedBefore,
		{
			outcome: 'ok',
			usage: result.usage,
			modelUsed: result.modelUsed,
			endpoint: result.provenance,
		},
		durationMs,
		undefined,
		{ isFallback: fallback, isCalibrated: result.calibrated, ...localTag(provider) }
	);
	await hold.end();
	const settlements = holdSettlements(ctx.meter);
	try {
		await ctx.recordUsage({
			...base,
			outcome: 'answered',
			durationMs,
			usage: result.usage,
			modelUsed: result.modelUsed,
			provenance: result.provenance,
			calibrated: result.calibrated,
			requests,
			...settlements.args,
		});
		ctx.meter.acknowledge(requests);
		settlements.markSent();
	} catch (error) {
		throw new DecisionAccountingFailure(error);
	}
	return result;
}

// ─── The dispatch ──────────────────────────────────────────────────────────

/** The one cast in the plane: an adapter answers a `QuestionSet`, a caller its own. */
function decided<Q extends QuestionSet>(
	result: DecisionResult,
	plane: ResolvedDecisionProvider,
	fallback: boolean,
	requestId: string,
	attempts: number
): RunDecisionResult<Q> {
	return {
		...result,
		answers: result.answers as AnswersFor<Q>,
		provider: plane.kind,
		fallback,
		requestId,
		attempts,
	};
}

/**
 * What a caller must have brought before the hop is on the table. The shape
 * checks are cheap; the last two are the point. `resolveDecisionFallback` hands
 * out a ready-made `fallbackTo`, so without this a single forgotten line would
 * buy an uncapped hop onto a model that costs 24 to 50 times more — with no
 * breaker to bound it and no ledger row for the spend ceiling to see.
 */
function assertFallbackShape<Q extends QuestionSet>(options: RunDecisionOptions<Q>): void {
	const plane = options.fallbackTo as ResolvedDecisionProvider;
	if (plane.kind !== 'llm') {
		throw new Error(
			`The decision fallback is one hop onto the language plane; got '${plane.kind}'.`
		);
	}
	if (plane.model === undefined) {
		throw new Error(
			'The decision fallback needs the resolved language model, not a bare config. ' +
				'lib/decisionProvider.ts resolves it.'
		);
	}
	if (options.breaker === undefined) {
		throw new Error(
			'The decision fallback needs its circuit breaker: pass the ctx-bound ' +
				'`internal.decision.breaker` port alongside `fallbackTo`, or pass neither.'
		);
	}
	if (options.recordUsage === undefined) {
		throw new Error(
			'The decision fallback needs its usage recorder: the hop must land in the ' +
				'llmUsageEvents ledger the spend ceiling reads, or it is unbounded spend.'
		);
	}
	if (options.admission === undefined) {
		throw new Error(
			'The decision fallback needs spend admission: the hop is a paid language call and ' +
				'is reserved before it runs (D3, ADR-0073). Pass the ctx-bound admission port.'
		);
	}
}

/**
 * Ask a question set, get one typed answer per question, with everything the
 * contract above guarantees around it. Throws rather than returning a degraded
 * answer: a decision nobody could make belongs to the caller's own fail-soft.
 */
export async function runDecision<Q extends QuestionSet>(
	callerOptions: RunDecisionOptions<Q>
): Promise<RunDecisionResult<Q>> {
	// The root's deadline binds every attempt, the backoff and the hop, whatever
	// adapter answers: it joins the caller's signal (ADR-0073).
	const options = withRootDeadline(callerOptions);
	const { abortSignal, allowance, fallbackTo, provider } = options;
	// Defensive, and cheap: the gate returns this shape and nothing else does,
	// but a hand-built object is the one way a call site could route around the
	// kill switch, and it should fail here rather than at the vendor.
	if (allowance?.allowed !== true) {
		throw new Error(
			"A decision needs the gate's answer: run internal.decision.gate.assertDecisionAllowed " +
				'in the same request and pass it as `allowance`.'
		);
	}
	if (fallbackTo) assertFallbackShape(options);
	if (options.admission && !options.recordUsage) {
		throw new Error(
			'A decision under spend admission needs its usage recorder: holds settle with the rows.'
		);
	}

	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? realSleep;
	const breaker = options.breaker ?? NO_HOP_BREAKER;
	const requestId = options.requestId ?? randomUUID();
	const ctx: AttemptContext<Q> = {
		options,
		requestId,
		recordUsage: options.recordUsage ?? (() => {}),
		rateLimiter: options.rateLimiter ?? NO_OP_RATE_LIMITER,
		meter: new LlmCallMeter({
			requestId,
			task: options.task ?? taskForFeature(options.feature),
			...(options.root ? { root: options.root } : {}),
			...(options.admission ? { admission: options.admission } : {}),
		}),
	};

	const budget = Math.max(1, options.maxAttempts ?? DEFAULT_DECISION_ATTEMPTS);
	const maxAttempts = decisionProviderFor(provider.kind).handlesRetries ? 1 : budget;

	let attempts = 0;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		assertNotAborted(abortSignal);
		attempts++;
		try {
			const result = await askOnce(ctx, provider, attempt, false);
			return decided(result, provider, false, ctx.requestId, attempts);
		} catch (error) {
			// A caller who cancelled gets their reason back untouched: no retry, no
			// hop, nothing told to the breaker. The provider did not fail — we
			// changed our mind.
			assertNotAborted(abortSignal);
			if (error instanceof DecisionAccountingFailure) throw error;
			lastError = error;
			if (!isRetriableDecisionError(error) || attempt === maxAttempts) break;
			const delayMs = backoffDelayMs(attempt - 1, retryAfterOf(error), random);
			if (delayMs === undefined) break;
			await sleep(delayMs, abortSignal);
		}
	}

	// Our own limiter refusing is not the provider failing, so it charges nothing
	// and ends here: charging it would let a busy minute drive the breaker open
	// and refuse the hop for the five minutes of real failures that follow.
	if (lastError instanceof DecisionRateLimitRefusal) throw lastError;
	// Our own spend admission said no: not a provider failure either (D3).
	if (admissionRefusalOf(lastError)) throw lastError;

	// Reported before the hop is considered, so a failure that trips the breaker
	// refuses its own hop. That is the conservative direction for a lever whose
	// failure mode is a bill.
	await breaker.recordFailure();

	// One hop, and only from here: the loop above has already spent the primary
	// plane's whole budget, so no path hops twice. A primary that IS the language
	// plane has nowhere to hop to — asking the same adapter again only bills again.
	if (!fallbackTo || provider.kind === 'llm' || !mayFallBack(lastError)) throw lastError;
	// Two readings of the same breaker, and both must allow it: the gate's, taken
	// when the request was admitted, and the breaker's now — the failures this
	// very call just reported are in the second one.
	if (!allowance.fallbackAllowed) throw lastError;
	if (await breaker.isOpen()) throw lastError;
	assertNotAborted(abortSignal);

	attempts++;
	return decided(
		await askOnce(ctx, fallbackTo, 1, true),
		fallbackTo,
		true,
		ctx.requestId,
		attempts
	);
}
