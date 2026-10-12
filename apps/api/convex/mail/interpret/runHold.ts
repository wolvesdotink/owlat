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
 *   - the verifier's maximum: one call per {@link VERIFY_BATCH_SIZE} of the
 *     most claims the output schema allows ({@link MAX_VERIFY_CLAIMS}), each
 *     bounded by the verify prompt's own bounds (`verify.ts`), the task's
 *     output ceiling and attempts.
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
import { reserveHold } from '../../analytics/admissionPorts';
import {
	INTERPRET_TEXT_LIMITS,
	MAX_INTERPRET_FACTS,
	MAX_INTERPRET_ITEMS,
	MAX_INTERPRET_TRANSITIONS,
	MAX_QUOTES_PER_CLAIM,
} from './schema';
import {
	buildVerifyPrompt,
	VERIFY_BATCH_SIZE,
	VERIFY_STATEMENT_CHARS,
	verdictSchema,
} from './verify';

/** Every item, transition and fact the output schema allows can become a claim. */
export const MAX_VERIFY_CLAIMS =
	MAX_INTERPRET_ITEMS + MAX_INTERPRET_TRANSITIONS + MAX_INTERPRET_FACTS;

/** UTF-8 bytes per UTF-16 unit at most (`analytics/embeddingBatchAdmission.ts`). */
const MAX_BYTES_PER_UNIT = 3;
/** A claim's id and framing in the verify prompt, beyond its statement and quotes. */
const CLAIM_FRAMING_UNITS = 64;
const QUOTE_FRAMING_UNITS = 8;

/** The run's hold, while it runs. */
export interface InterpretRunHold {
	/** Spread into every call's spend target: the call draws on this hold. */
	readonly target: { readonly reservationId?: string };
	/** Count a call's provider requests (its meter's, retries included). */
	count(requests: number): void;
	/** Settle against the counted requests, or release when none was sent. Once. */
	settle(): Promise<void>;
}

const NO_RUN_HOLD: InterpretRunHold = Object.freeze({
	target: {},
	count: () => {},
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
		readonly root: LlmRootContext;
		readonly priority: AdmissionPriority;
	}
): Promise<InterpretRunHold> {
	const extractSize = dispatchRequestSize(opts.extract.prompt);
	const extract = callBound(opts.extract.model, 'mail.extract', {
		bytes: extractSize.bytes + serializedBytes(zodSchema(opts.extract.schema).jsonSchema),
		messages: extractSize.messages,
	});
	const verify = callBound(opts.verifyModel, 'mail.verify', {
		bytes: verifyRequestBytes(),
		messages: 1,
	});
	const verifyCalls = Math.ceil(MAX_VERIFY_CLAIMS / VERIFY_BATCH_SIZE);
	const microusd = extract.microusd + verifyCalls * verify.microusd;
	if (microusd === 0) return NO_RUN_HOLD;
	const held = await reserveHold(ctx, {
		task: 'mail.extract',
		plane: 'language',
		budgetClass: 'standard',
		priority: opts.priority,
		root: opts.root,
		microusd,
		maxRequests: extract.maxRequests + verifyCalls * verify.maxRequests,
		requestBound: { microusd: Math.max(extract.maxRequestMicrousd, verify.maxRequestMicrousd) },
		...('modelId' in extract ? { modelId: extract.modelId } : {}),
		...('endpoint' in extract && extract.endpoint ? { endpoint: extract.endpoint } : {}),
	});
	if (!held) return NO_RUN_HOLD;
	const { reservationId } = held;
	let requests = 0;
	let isSettled = false;
	return {
		target: { reservationId },
		count: (n) => {
			requests += n;
		},
		settle: async () => {
			if (isSettled) return;
			isSettled = true;
			if (requests === 0) {
				await ctx
					.runMutation(internal.aiRouting.admission.release, { reservationId })
					.catch(() => undefined);
				return;
			}
			// One ledger row per provider request: the hold settles once all are in.
			await ctx
				.runMutation(internal.aiRouting.admission.settle, {
					reservationId,
					expectedRequests: requests,
				})
				.catch(() => undefined);
		},
	};
}
