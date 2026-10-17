'use node';

/**
 * One spend hold for a whole interpretation run (ADR-0073, D1; Sol r4).
 *
 * The plan's rule is to reserve the complete allowed path before dispatch. An
 * interpretation buys an extraction and then up to a schema-bounded number of
 * verifier calls; reserving them one by one let the verifier be refused after
 * the extraction was paid, which needed a deferral path of its own. Instead,
 * before the extraction, the run admits ONE hold covering:
 *
 *   - the extraction: its actual prompt and schema, the task's output
 *     ceiling, every attempt the task allows;
 *   - the verification path that will actually run (`verifyRoute.ts
 *     planVerification`, decided before the extraction), for the most claims
 *     it may check (the schema's {@link MAX_VERIFY_CLAIMS}, or the policy's
 *     per-message cap when lower):
 *     - the language verifier: one call per {@link VERIFY_BATCH_SIZE} claims,
 *       each bounded by the verify prompt's own bounds (`verify.ts`), the
 *       task's output ceiling and attempts;
 *     - claim checks on the decision rung: one decision call per claim, each
 *       bounded by the largest claim state, the native output ceiling and the
 *       task's attempts (free on a local engine);
 *     - nothing, when no verification call can run (an unavailable provider).
 *   Each path is sized on its own; the run never holds for a path it will
 *   not take, and a claim check never asks for a hold of its own.
 *
 * The language calls (the extraction, the language verifier) are one
 * allocation on the language plane; the claim checks are a second on the
 * decision plane (Sol r3 F1). Both are admitted in ONE admission mutation
 * (`aiRouting/admission.ts reserveRun`), each against its own plane's
 * capacity and the shared ceiling: either both hold or neither does. Each
 * settles on its own plane, its unknown-usage estimates included.
 *
 * A refused hold defers the whole run before anything is spent (`run.ts`).
 * An admitted one is drawn on by every call of the run: their spend targets
 * carry its id, so the dispatch reserves nothing more and cannot refuse
 * halfway. The run settles it once against the provider requests it counted
 * (zero releases it); rows that never arrive leave it for the expiry sweep.
 */

import { zodSchema, type LanguageModel } from 'ai';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { callShape } from '../../lib/llm/callShape';
import { LlmCallMeter, type LlmRootContext } from '../../lib/llm/requestMeter';
import { modelMaxOutputTokens } from '../../lib/llm/modelOutputLimits';
import { MAX_LLM_ATTEMPTS } from '../../lib/llm/retryPolicy';
import {
	dispatchHoldMicrousd,
	dispatchRequestSize,
	FALLBACK_OUTPUT_TOKENS,
	serializedBytes,
	utf8Bytes,
} from '../../lib/llm/admissionPort';
import type { AdmissionPriority } from '../../lib/validators/aiRouting';
import { reserveHolds } from '../../analytics/admissionPorts';
import { INTERPRET_TEXT_LIMITS, MAX_QUOTES_PER_CLAIM } from './schema';
import { CLAIM_STATEMENT_CHARS } from './claimCheck';
import { CLAIM_CHECK_QUESTIONS } from '../../lib/decision/catalog';
import {
	NATIVE_DECISION_OUTPUT_TOKENS,
	NATIVE_WIRE_EXPANSION,
} from '../../lib/decision/attemptAdmission';
import { DEFAULT_DECISION_ATTEMPTS } from '../../lib/decision/dispatch';
import { decisionProviderFor } from '../../lib/decisionProviders';
import type { ResolvedDecisionPlane } from '../../lib/decisionProvider';
import { taskPolicy } from '../../lib/llm/taskPolicy';
import {
	buildVerifyPrompt,
	MAX_VERIFY_CLAIMS,
	VERIFY_BATCH_SIZE,
	VERIFY_STATEMENT_CHARS,
	verdictSchema,
} from './verify';

/** UTF-8 bytes per UTF-16 unit at most (`analytics/embeddingBatchAdmission.ts`). */
const MAX_BYTES_PER_UNIT = 3;
/** A claim's id and framing in the verify prompt, beyond its statement and quotes. */
const CLAIM_FRAMING_UNITS = 64;
const QUOTE_FRAMING_UNITS = 8;
/** The most bytes JSON writes for one character. */
const JSON_ESCAPE_BYTES = 6;

/** The verification path the run will take, as the hold sizes it. */
export type VerifyHoldPlan =
	| { readonly kind: 'language'; readonly claims: number }
	| { readonly kind: 'decision'; readonly claims: number; readonly plane: ResolvedDecisionPlane }
	| { readonly kind: 'none' };

/** A call's spend target fields under the run's hold. */
type HoldTarget = { readonly reservationId?: string; readonly requestId?: string };

/** The run's hold, while it runs. */
export interface InterpretRunHold {
	/** Spread into the extraction's spend target: it draws on this hold. */
	readonly extractTarget: HoldTarget;
	/** Spread into verify batch `batch`'s spend target (0-based). */
	verifyTarget(batch: number): HoldTarget;
	/** Claim check `index`'s hold and request id (0-based), on the decision path. */
	claimCheckTarget(index: number): HoldTarget;
	/** Count a language call's provider requests (its meter's, retries included). */
	count(requests: number): void;
	/** Count a claim check's provider requests, on the decision allocation. */
	countClaimChecks(requests: number): void;
	/** Settle against the counted requests, or release when none was sent. Once. */
	settle(): Promise<void>;
}

const NO_RUN_HOLD: InterpretRunHold = Object.freeze({
	extractTarget: {},
	verifyTarget: () => ({}),
	claimCheckTarget: () => ({}),
	count: () => {},
	countClaimChecks: () => {},
	settle: async () => {},
});

/** One call's worst case: every attempt the task allows, each at the output ceiling. */
function callBound(
	model: LanguageModel,
	task: AiTaskName,
	request: { readonly bytes: number; readonly messages: number }
) {
	const shape = callShape({ model, meter: new LlmCallMeter({ task }) });
	if (shape.requestBase.isLocalEngine)
		return { microusd: 0, maxRequests: 0, maxRequestMicrousd: 0 };
	const endpoint = shape.requestBase.endpoint;
	const bound = dispatchHoldMicrousd({
		modelId: shape.modelUsed,
		plane: 'language',
		...(endpoint ? { endpoint } : {}),
		bytes: request.bytes,
		messages: request.messages,
		outputTokens:
			shape.maxOutputTokens ?? modelMaxOutputTokens(shape.modelUsed) ?? FALLBACK_OUTPUT_TOKENS,
		steps: 1,
		attempts: shape.maxAttempts ?? MAX_LLM_ATTEMPTS,
		retries: 'every_step',
	});
	return { ...bound, modelId: shape.modelUsed, ...(endpoint ? { endpoint } : {}) };
}

/** The bytes of the largest claim-check request: the largest claim state and the questions, on the wire. */
export function claimCheckRequestBytes(): number {
	const state = {
		claim: 'x'.repeat(CLAIM_STATEMENT_CHARS),
		quotes: Array.from({ length: MAX_QUOTES_PER_CLAIM }, () =>
			'x'.repeat(INTERPRET_TEXT_LIMITS.quote)
		),
	};
	// JSON escapes a character into at most six bytes (`\u0000`).
	return (
		NATIVE_WIRE_EXPANSION *
		JSON_ESCAPE_BYTES *
		serializedBytes({ state, questions: CLAIM_CHECK_QUESTIONS })
	);
}

/** One claim check's worst case on the decision plane, or nothing on a local engine. */
function claimCheckBound(plane: ResolvedDecisionPlane) {
	const adapter = decisionProviderFor(plane.kind);
	if (adapter.isLocal) return { microusd: 0, maxRequests: 0, maxRequestMicrousd: 0 };
	const modelId = plane.modelId || adapter.defaultModel;
	return {
		...dispatchHoldMicrousd({
			modelId,
			plane: 'decision',
			bytes: claimCheckRequestBytes(),
			messages: 1,
			outputTokens: NATIVE_DECISION_OUTPUT_TOKENS,
			steps: 1,
			attempts: Math.max(taskPolicy('mail.claim_check').maxAttempts, DEFAULT_DECISION_ATTEMPTS),
			retries: 'every_step',
		}),
		modelId,
	};
}

/** The bytes of the largest verify request the prompt's bounds allow. */
export function verifyRequestBytes(): number {
	const claimUnits =
		CLAIM_FRAMING_UNITS +
		VERIFY_STATEMENT_CHARS +
		MAX_QUOTES_PER_CLAIM * (INTERPRET_TEXT_LIMITS.quote + QUOTE_FRAMING_UNITS);
	return (
		utf8Bytes(buildVerifyPrompt([])) +
		VERIFY_BATCH_SIZE * claimUnits * MAX_BYTES_PER_UNIT +
		serializedBytes(zodSchema(verdictSchema).jsonSchema)
	);
}

/**
 * Admit the run's hold, or throw `AdmissionRefusedError` (the run defers).
 * No ceiling configured, or local models only: nothing is held.
 */
export async function admitInterpretRun(
	ctx: ActionCtx,
	opts: {
		readonly extract: {
			readonly model: LanguageModel;
			readonly prompt: Parameters<typeof dispatchRequestSize>[0];
			readonly schema: Parameters<typeof zodSchema>[0];
		};
		readonly verifyModel: LanguageModel;
		/** The verification path planned before the extraction (`verifyRoute.ts`). */
		readonly verify: VerifyHoldPlan;
		readonly root: LlmRootContext;
		readonly priority: AdmissionPriority;
		/** Reserve through the caller's mutation (read on arrival acts on a refusal there). */
		readonly reserve?: NonNullable<Parameters<typeof reserveHolds>[2]>['reserve'];
	}
): Promise<InterpretRunHold> {
	const extractSize = dispatchRequestSize(opts.extract.prompt);
	const extract = callBound(opts.extract.model, 'mail.extract', {
		bytes: extractSize.bytes + serializedBytes(zodSchema(opts.extract.schema).jsonSchema),
		messages: extractSize.messages,
	});
	const plan = opts.verify;
	const claims = plan.kind === 'none' ? 0 : Math.min(plan.claims, MAX_VERIFY_CLAIMS);
	// The path the run will take: the language verifier's calls on the
	// language allocation, or the claim checks on a decision allocation of
	// their own (Sol r3 F1). One bound per call, and that many calls.
	const verify =
		plan.kind === 'language'
			? callBound(opts.verifyModel, 'mail.verify', { bytes: verifyRequestBytes(), messages: 1 })
			: undefined;
	const checks = plan.kind === 'decision' ? claimCheckBound(plan.plane) : undefined;
	const verifyCalls = verify ? Math.ceil(claims / VERIFY_BATCH_SIZE) : 0;
	const checkCalls = checks ? claims : 0;
	// Every call of the run gets its request id now, so each of its attempts has
	// its own bound on its allocation: unknown usage is charged at that call's
	// own bound, never at another's (Sol r5 F2).
	const extractRequestId = globalThis.crypto.randomUUID();
	const verifyRequestIds = Array.from({ length: verifyCalls }, () =>
		globalThis.crypto.randomUUID()
	);
	const checkRequestIds = Array.from({ length: checkCalls }, () => globalThis.crypto.randomUUID());
	const keyed = (requestId: string, call: { maxRequests: number; maxRequestMicrousd: number }) =>
		Array.from({ length: call.maxRequests }, (_, index) => ({
			requestId,
			attempt: index + 1,
			microusd: call.maxRequestMicrousd,
		}));
	const languageBounds = [
		...keyed(extractRequestId, extract),
		...(verify ? verifyRequestIds.flatMap((requestId) => keyed(requestId, verify)) : []),
	];
	const decisionBounds = checks
		? checkRequestIds.flatMap((requestId) => keyed(requestId, checks))
		: [];
	const languageMicrousd = extract.microusd + verifyCalls * (verify?.microusd ?? 0);
	const decisionMicrousd = checkCalls * (checks?.microusd ?? 0);
	const allocations = [
		allocation({
			task: 'mail.extract',
			plane: 'language',
			microusd: languageMicrousd,
			maxRequests: extract.maxRequests + verifyCalls * (verify?.maxRequests ?? 0),
			bounds: languageBounds,
			call: extract,
		}),
		checks
			? allocation({
					task: 'mail.claim_check',
					plane: 'decision',
					microusd: decisionMicrousd,
					maxRequests: checkCalls * checks.maxRequests,
					bounds: decisionBounds,
					call: checks,
				})
			: null,
	];
	const wanted = allocations.filter((a): a is NonNullable<typeof a> => a !== null);
	if (wanted.length === 0) return NO_RUN_HOLD;
	// Both allocations in ONE admission mutation: refused, nothing is held.
	const ids = await reserveHolds(
		ctx,
		wanted.map((a) => ({
			...a,
			budgetClass: 'standard' as const,
			priority: opts.priority,
			root: opts.root,
		})),
		opts.reserve ? { reserve: opts.reserve } : {}
	);
	const languageId = wanted[0]?.plane === 'language' ? (ids[0] ?? undefined) : undefined;
	const decisionIndex = wanted.findIndex((a) => a.plane === 'decision');
	const decisionId = decisionIndex >= 0 ? (ids[decisionIndex] ?? undefined) : undefined;
	if (!languageId && !decisionId) return NO_RUN_HOLD;
	const language = settleable(ctx, languageId);
	const decision = settleable(ctx, decisionId);
	const target = (reservationId: string | undefined, requestId: string | undefined) =>
		reservationId ? (requestId ? { reservationId, requestId } : { reservationId }) : {};
	return {
		extractTarget: target(languageId, extractRequestId),
		verifyTarget: (batch) => target(languageId, verifyRequestIds[batch]),
		claimCheckTarget: (index) => target(decisionId, checkRequestIds[index]),
		count: language.count,
		countClaimChecks: decision.count,
		settle: async () => {
			await Promise.all([language.settle(), decision.settle()]);
		},
	};
}

/** One allocation of the run's path, or null when it costs nothing (a local engine). */
function allocation(opts: {
	readonly task: AiTaskName;
	readonly plane: 'language' | 'decision';
	readonly microusd: number;
	readonly maxRequests: number;
	readonly bounds: readonly { requestId: string; attempt: number; microusd: number }[];
	readonly call: object;
}) {
	const call = opts.call as { readonly modelId?: string; readonly endpoint?: string };
	const [first, ...rest] = opts.bounds;
	if (opts.microusd === 0 || !first) return null;
	return {
		task: opts.task,
		plane: opts.plane,
		microusd: opts.microusd,
		maxRequests: opts.maxRequests,
		requestBound: first,
		requestBounds: rest,
		...(call.modelId ? { modelId: call.modelId } : {}),
		...(call.endpoint ? { endpoint: call.endpoint } : {}),
	};
}

/** One allocation's request count, and its settlement (released when nothing was sent). Once. */
function settleable(ctx: ActionCtx, reservationId: string | undefined) {
	let requests = 0;
	let isSettled = false;
	return {
		count: (n: number) => {
			requests += n;
		},
		settle: async () => {
			if (!reservationId || isSettled) return;
			isSettled = true;
			if (requests === 0) {
				await ctx
					.runMutation(internal.aiRouting.admission.release, { reservationId })
					.catch(() => undefined);
				return;
			}
			// One ledger row per provider request: the allocation settles once all are in.
			await ctx
				.runMutation(internal.aiRouting.admission.settle, {
					reservationId,
					expectedRequests: requests,
				})
				.catch(() => undefined);
		},
	};
}
