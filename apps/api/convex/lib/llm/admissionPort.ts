/**
 * Spend admission at the dispatch: the refusal error
 * every caller sees, and the estimates a hold is sized with. The dispatch side
 * (`./dispatchAdmission.ts`) reserves before each provider request through the
 * meter's port (`AdmissionPort`, installed by `analytics/meteredSpend.ts`
 * `meterFor`). Pure and runtime-neutral.
 */

import { ConvexError } from 'convex/values';
import { AI_BUDGET_ERROR_CODE, type BudgetHoldReason } from '@owlat/shared/aiRouting';
import type { TokenUsage } from '../../agent/steps/types';
import { estimateAdmissionCostMicrousd, estimateCost, type AdmissionProvenance } from './pricing';
import { LANGUAGE_ENDPOINT_PROVENANCES } from '../llmProviders/types';
import { DECISION_ENDPOINT_PROVENANCES } from '../decisionProviders/types';
import { usdToMicrousd } from '../aiRouting/spendPeriods';
import type { LlmUsagePlane } from '../llmUsageTags';

export type { AdmissionPort, DispatchEstimate } from './requestMeter';

/** The refusal's payload, in the Operation error shape the web reads (`error.data`). */
export interface AdmissionRefusalData {
	readonly code: typeof AI_BUDGET_ERROR_CODE;
	readonly reason: BudgetHoldReason;
	readonly limit: string;
}

const REFUSAL_MESSAGE: Readonly<Record<BudgetHoldReason, string>> = {
	daily_ceiling: 'The AI spend budget for today is used up. Try again tomorrow.',
	monthly_ceiling: 'The AI spend budget for this month is used up.',
	spend_unverifiable:
		'AI spend cannot be verified right now, so no paid AI call is made. Try again in a few minutes.',
};

/**
 * A paid call admission refused. A `ConvexError` in the Operation error
 * shape (`{ category: 'forbidden', message, data: { code, reason, limit } }`),
 * so it reaches a client unchanged; never retried and never a fallback hop.
 */
export class AdmissionRefusedError extends ConvexError<{
	category: 'forbidden';
	message: string;
	data: { code: string; reason: string; limit: string };
}> {
	readonly reason: BudgetHoldReason;
	readonly limit: string;
	/** Read by the decision plane's retry classifier. */
	readonly retriable = false;

	constructor(reason: BudgetHoldReason, limit: string) {
		super({
			category: 'forbidden',
			message: REFUSAL_MESSAGE[reason],
			data: { code: AI_BUDGET_ERROR_CODE, reason, limit },
		});
		this.name = 'AdmissionRefusedError';
		this.reason = reason;
		this.limit = limit;
	}
}

/**
 * The refusal an error carries, also after it crossed an action boundary
 * (where only the `ConvexError` data survives), or null.
 */
export function admissionRefusalOf(error: unknown): AdmissionRefusalData | null {
	// A refusal after billed steps arrives wrapped (`LlmPartialUsageError`).
	const cause = (error as { cause?: unknown } | null)?.cause;
	if (cause !== undefined && cause !== error && !(error instanceof AdmissionRefusedError)) {
		const wrapped = admissionRefusalOf(cause);
		if (wrapped) return wrapped;
	}
	if (error instanceof AdmissionRefusedError) {
		return { code: AI_BUDGET_ERROR_CODE, reason: error.reason, limit: error.limit };
	}
	const data = (
		error as { data?: { data?: { code?: unknown; reason?: unknown; limit?: unknown } } }
	)?.data?.data;
	if (data?.code !== AI_BUDGET_ERROR_CODE) return null;
	const reason = data.reason;
	if (
		reason !== 'daily_ceiling' &&
		reason !== 'monthly_ceiling' &&
		reason !== 'spend_unverifiable'
	) {
		return null;
	}
	return {
		code: AI_BUDGET_ERROR_CODE,
		reason,
		limit: typeof data.limit === 'string' ? data.limit : '',
	};
}

/**
 * Let a spend-admission refusal through a fail-soft catch: background work
 * then defers (`analytics/backgroundDeferral.ts`), a Team step is held, and a
 * user's action shows the budget error. Anything else stays the catch's.
 */
export function rethrowAdmissionRefusal(error: unknown): void {
	if (admissionRefusalOf(error)) throw error;
}

/** The sentence a person reads for a budget refusal of `reason`. */
export function budgetRefusalMessage(reason: BudgetHoldReason): string {
	return REFUSAL_MESSAGE[reason];
}

/**
 * HOLD SIZING. A hold must be an upper bound on what the
 * request can be billed, or concurrent calls overshoot the ceiling.
 *
 * - INPUT: the UTF-8 byte length of the whole serialized request (system,
 *   messages, tool definitions, the structured-output schema). Byte-level BPE
 *   and SentencePiece with byte fallback never produce more tokens than bytes,
 *   so bytes bound the input tokens in any script, where characters do not (a
 *   CJK character or an emoji is one character and up to four tokens). Each
 *   message adds a fixed allowance for the role and separator tokens the
 *   provider inserts, and the request a fixed allowance on top.
 * - OUTPUT: the request's output ceiling (finite for every generative task),
 *   which the provider enforces on everything it bills as output.
 * - PRICE: the larger of the ledger's own price (`estimateCost`, which prices
 *   the settled row, with the plane's fallback for an unknown model) and the
 *   admission price where the endpoint and model are in the admission catalog
 *   (list rates plus the cache-write ceiling on input).
 *
 * Inputs this does not bound: image and file parts priced by the provider
 * per image. No call site sends them today.
 */

/** Tokens the provider may add per message (role, separators). */
const PER_MESSAGE_TOKENS = 16;
/** Tokens the provider may add per request (the reply priming, a system frame). */
const PER_REQUEST_TOKENS = 64;
/** What one tool round may add to the next round's input, for the worst-case (unwrapped) hold. */
const TOOL_RESULT_BYTES = 16_384;
/** The output ceiling when neither the task nor the model names one. */
export const FALLBACK_OUTPUT_TOKENS = 8_192;
/** A value that cannot be serialized counts as this many bytes. */
const UNSERIALIZABLE_BYTES = 65_536;

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): number {
	return encoder.encode(text).length;
}

/** UTF-8 bytes of a value serialized as JSON (an abort signal or a function counts as nothing). */
export function serializedBytes(value: unknown): number {
	try {
		const json = JSON.stringify(value, (key, inner: unknown) =>
			key === 'abortSignal' || typeof inner === 'function' ? undefined : inner
		);
		return json === undefined ? 0 : utf8Bytes(json);
	} catch {
		return UNSERIALIZABLE_BYTES;
	}
}

/** The input-token upper bound of a request of `bytes` serialized bytes and `messages` messages. */
export function inputTokenBound(bytes: number, messages: number): number {
	return (
		Math.max(0, Math.ceil(bytes)) + Math.max(1, messages) * PER_MESSAGE_TOKENS + PER_REQUEST_TOKENS
	);
}

/** The size of a dispatch's request before the provider parameters exist (an unwrapped model). */
export function dispatchRequestSize(input: {
	readonly prompt?: string;
	readonly system?: string;
	readonly messages?: readonly unknown[];
	readonly tools?: unknown;
	readonly schema?: unknown;
}): { bytes: number; messages: number } {
	const bytes =
		utf8Bytes(input.prompt ?? '') +
		utf8Bytes(input.system ?? '') +
		serializedBytes(input.messages ?? []) +
		(input.tools === undefined ? 0 : serializedBytes(input.tools)) +
		(input.schema === undefined ? 0 : UNSERIALIZABLE_BYTES);
	const messages =
		(input.messages?.length ?? 0) + (input.prompt !== undefined ? 1 : 0) + (input.system ? 1 : 0);
	return { bytes, messages };
}

/** The price of `usage`: the larger of the ledger's price and the admission catalog's. */
export function costMicrousd(
	modelId: string,
	usage: TokenUsage,
	plane: LlmUsagePlane,
	endpoint?: string
): number {
	const ledger = usdToMicrousd(estimateCost(modelId, usage, plane).costUsd);
	const admission =
		endpoint !== undefined && isAdmissionProvenance(endpoint)
			? estimateAdmissionCostMicrousd(endpoint, modelId, usage)
			: undefined;
	return Math.max(ledger, admission ?? 0);
}

/** One request's bound: input from its serialized size, output at its ceiling. */
export function requestHoldMicrousd(opts: {
	readonly modelId: string;
	readonly plane: LlmUsagePlane;
	readonly endpoint?: string;
	readonly bytes: number;
	readonly messages: number;
	readonly outputTokens: number;
}): number {
	const promptTokens = inputTokenBound(opts.bytes, opts.messages);
	return costMicrousd(
		opts.modelId,
		{
			promptTokens,
			completionTokens: opts.outputTokens,
			totalTokens: promptTokens + opts.outputTokens,
		},
		opts.plane,
		opts.endpoint
	);
}

/**
 * The worst case of one dispatch whose requests cannot be seen one by one (a
 * model the admission middleware cannot wrap): `steps` rounds whose input
 * grows by the previous output and a tool result each round, each sent up to
 * `attempts` times, or only the opening request retried (a stream). Also the
 * bound of its costliest single request, which unknown usage is charged at.
 */
export function dispatchHoldMicrousd(opts: {
	readonly modelId: string;
	readonly plane: LlmUsagePlane;
	readonly endpoint?: string;
	readonly bytes: number;
	readonly messages: number;
	readonly outputTokens: number;
	readonly steps: number;
	readonly attempts: number;
	readonly retries: 'every_step' | 'opening_only';
}): { microusd: number; maxRequests: number; maxRequestMicrousd: number } {
	const steps = Math.max(1, Math.floor(opts.steps));
	const attempts = Math.max(1, Math.floor(opts.attempts));
	let perPass = 0;
	let opening = 0;
	let costliest = 0;
	for (let step = 0; step < steps; step++) {
		const cost = requestHoldMicrousd({
			...opts,
			// Each round adds the previous output (at most four bytes a token) and a tool result.
			bytes: opts.bytes + step * (opts.outputTokens * 4 + TOOL_RESULT_BYTES),
			messages: opts.messages + step * 2,
		});
		if (step === 0) opening = cost;
		perPass += cost;
		costliest = Math.max(costliest, cost);
	}
	if (opts.retries === 'every_step') {
		return {
			microusd: perPass * attempts,
			maxRequests: steps * attempts,
			maxRequestMicrousd: costliest,
		};
	}
	return {
		microusd: perPass + opening * (attempts - 1),
		maxRequests: steps + attempts - 1,
		maxRequestMicrousd: costliest,
	};
}

const ADMISSION_PROVENANCES: ReadonlySet<string> = new Set<string>([
	...LANGUAGE_ENDPOINT_PROVENANCES,
	...DECISION_ENDPOINT_PROVENANCES,
]);

function isAdmissionProvenance(endpoint: string): endpoint is AdmissionProvenance {
	return ADMISSION_PROVENANCES.has(endpoint);
}
