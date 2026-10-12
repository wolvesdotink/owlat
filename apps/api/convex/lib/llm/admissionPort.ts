/**
 * Spend admission at the dispatch (ADR-0073, Phase 1b): the refusal error
 * every caller sees, and the estimates a hold is sized with. The dispatch side
 * (`./dispatchAdmission.ts`) reserves before each provider request through the
 * meter's port (`AdmissionPort`, installed by `analytics/meteredSpend.ts`
 * `meterFor`). Pure and runtime-neutral.
 */

import { ConvexError } from 'convex/values';
import { AI_BUDGET_ERROR_CODE, type BudgetHoldReason } from '@owlat/shared/aiRouting';
import type { TokenUsage } from '../../agent/steps/types';
import { estimateCost } from './pricing';
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
 * A paid call admission refused (D1). A `ConvexError` in the Operation error
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

/** Characters per token for the input estimate: low, so the estimate errs high. */
const CHARS_PER_TOKEN = 3;
/** Per-request framing the prompt text does not show (roles, schema, tool definitions). */
const REQUEST_OVERHEAD_TOKENS = 1_000;
/** What one tool round may add to the next round's input. */
const TOOL_RESULT_TOKENS = 2_000;
/** The output ceiling when neither the task nor the model names one. */
export const FALLBACK_OUTPUT_TOKENS = 8_192;

/** Input tokens a text of `chars` characters may count as. */
export function inputTokensFor(chars: number): number {
	return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN) + REQUEST_OVERHEAD_TOKENS;
}

/** The characters of a prompt, a system text and a message list, as the model reads them. */
export function promptChars(input: {
	readonly prompt?: string;
	readonly system?: string;
	readonly messages?: readonly unknown[];
}): number {
	let chars = (input.prompt?.length ?? 0) + (input.system?.length ?? 0);
	for (const message of input.messages ?? []) {
		try {
			chars += JSON.stringify(message)?.length ?? 0;
		} catch {
			chars += 4_000;
		}
	}
	return chars;
}

export function costMicrousd(modelId: string, usage: TokenUsage, plane: LlmUsagePlane): number {
	return usdToMicrousd(estimateCost(modelId, usage, plane).costUsd);
}

/**
 * The worst case of one dispatch in integer micro-USD: `steps` rounds whose
 * input grows by the previous output and a tool result each round, each sent
 * up to `attempts` times (`attemptsPerStep`), or only the opening request
 * retried (`openingOnly`, a stream).
 */
export function dispatchHoldMicrousd(opts: {
	readonly modelId: string;
	readonly plane: LlmUsagePlane;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly steps: number;
	readonly attempts: number;
	readonly retries: 'every_step' | 'opening_only';
}): { microusd: number; maxRequests: number } {
	const steps = Math.max(1, Math.floor(opts.steps));
	const attempts = Math.max(1, Math.floor(opts.attempts));
	let perPass = 0;
	let opening = 0;
	for (let step = 0; step < steps; step++) {
		const promptTokens = opts.inputTokens + step * (opts.outputTokens + TOOL_RESULT_TOKENS);
		const cost = costMicrousd(
			opts.modelId,
			{
				promptTokens,
				completionTokens: opts.outputTokens,
				totalTokens: promptTokens + opts.outputTokens,
			},
			opts.plane
		);
		if (step === 0) opening = cost;
		perPass += cost;
	}
	if (opts.retries === 'every_step') {
		return { microusd: perPass * attempts, maxRequests: steps * attempts };
	}
	return { microusd: perPass + opening * (attempts - 1), maxRequests: steps + attempts - 1 };
}

/** One request's worst case: `inputChars` of prompt and `outputTokens` of output. */
export function requestHoldMicrousd(opts: {
	readonly modelId: string;
	readonly plane: LlmUsagePlane;
	readonly inputChars: number;
	readonly outputTokens: number;
}): number {
	const promptTokens = inputTokensFor(opts.inputChars);
	return costMicrousd(
		opts.modelId,
		{
			promptTokens,
			completionTokens: opts.outputTokens,
			totalTokens: promptTokens + opts.outputTokens,
		},
		opts.plane
	);
}
