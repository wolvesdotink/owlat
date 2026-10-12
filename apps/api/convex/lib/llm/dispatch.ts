'use node';

/**
 * Shared LLM dispatch for every LLM call in the deployment. Owns the one
 * mapping between the AI SDK's `usage` shape and the lifecycle's TokenUsage
 * validator (`./providerUsage.ts`) — adding or rotating SDKs touches one place.
 *
 * Per ADR-0029: lifted from agent/steps/shared/llm.ts (ADR-0014 seam) to a
 * shared location so non-agent callers (translate, knowledge/extraction,
 * semanticFileProcessing, visualizationAgent) can use the same surface.
 *
 * METERING (ADR-0073). Every helper takes an optional {@link LlmCallMeter} and
 * records each PROVIDER REQUEST into it: every retry attempt, every tool round,
 * every stream step, failed ones included. The caller's spend helper
 * (`analytics/meteredSpend.ts`) turns those records into ledger rows, one per
 * request. The meter's task sets the limits this file enforces
 * (`./taskLimits.ts`): an output ceiling covering reasoning, a deadline for
 * the whole call, and the attempt allowance.
 */

import {
	generateObject,
	generateText,
	NoObjectGeneratedError,
	stepCountIs,
	wrapLanguageModel,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
} from 'ai';
import type { z } from 'zod';
import type { TokenUsage } from '../../agent/steps/types';
import { modelForRequest } from './requestPolicy';
import { withLlmRetry } from './retryPolicy';
import { withPartialUsage } from './partialUsage';
import { addTokenUsage } from './tokenUsage';
import { normalizeUsage, usageDetails, type RawUsage } from './providerUsage';
import { startRequest, type LlmCallMeter } from './requestMeter';
import { callShape, limitArgs } from './callShape';
import { DEFAULT_MAX_TOOL_STEPS } from './dispatchStream';

export { MAX_LLM_ATTEMPTS, errorStatus, isRetriableLlmError, retryAfterMs } from './retryPolicy';
export { normalizeUsage } from './providerUsage';
export { DEFAULT_MAX_TOOL_STEPS, runLlmStream } from './dispatchStream';

/**
 * The AI SDK retries every call twice on its own by default. This module is
 * the one retry choke point, so each SDK call is told not to: otherwise one
 * dispatch attempt hides up to three HTTP requests (nine per call in total),
 * which breaks both deadlines and the per-attempt budget arithmetic. Streams
 * are the exception (see `./dispatchStream.ts`).
 */
const SDK_MAX_RETRIES = 0;

const MAX_PROVIDER_MODEL_ID_LENGTH = 256;

function hasAsciiControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});
}

/**
 * Read only a bounded, unambiguous model identity reported by the provider.
 * Hard-budget callers must never substitute the requested model when this
 * metadata is absent or malformed: doing so would hide provider-side reroutes.
 */
function validProviderReportedModelId(modelId: unknown): string | undefined {
	if (
		typeof modelId !== 'string' ||
		modelId.length < 1 ||
		modelId.length > MAX_PROVIDER_MODEL_ID_LENGTH ||
		modelId.trim() !== modelId ||
		hasAsciiControlCharacter(modelId)
	) {
		return undefined;
	}
	return modelId;
}

interface ProviderModelIdentityCapture {
	readonly model: LanguageModel;
	read(): string | undefined;
}

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;

function isLanguageModelV3(model: LanguageModel): model is LanguageModelV3 {
	return typeof model === 'object' && model !== null && model.specificationVersion === 'v3';
}

/** Capture raw provider metadata before AI SDK fills a missing ID from the request. */
function captureProviderModelIdentity(model: LanguageModel): ProviderModelIdentityCapture {
	if (!isLanguageModelV3(model)) return { model, read: () => undefined };
	let rawModelId: unknown;
	return {
		model: wrapLanguageModel({
			model,
			middleware: {
				specificationVersion: 'v3',
				wrapGenerate: async ({ doGenerate }) => {
					rawModelId = undefined;
					const result = await doGenerate();
					rawModelId = result.response?.modelId;
					return result;
				},
			},
		}),
		read: () => validProviderReportedModelId(rawModelId),
	};
}

/** What one finished provider request reported, as a meter record's fields. */
function reported(usage: RawUsage) {
	const tokenUsage = normalizeUsage(usage);
	return { ...(tokenUsage ? { usage: tokenUsage } : {}), ...usageDetails(usage) };
}

export type LlmTextInput = { messages: ModelMessage[] } | { prompt: string; system?: string };

export type LlmTextOptions = LlmTextInput & {
	model: LanguageModel;
	temperature?: number;
	maxOutputTokens?: number;
	/** Cancels the call and the backoff between attempts (a deadline, a user stop). */
	abortSignal?: AbortSignal;
	/**
	 * Lower the attempt ceiling below {@link MAX_LLM_ATTEMPTS}. Interactive
	 * surfaces pass `INTERACTIVE_LLM_ATTEMPTS` (one retry at most).
	 */
	maxAttempts?: number;
	/** Records each provider request; its task sets the call's limits. */
	meter?: LlmCallMeter;
};

export interface LlmTextResult {
	text: string;
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
}

export async function runLlmText(opts: LlmTextOptions): Promise<LlmTextResult> {
	const { result } = await runLlmTextWithAttemptMetadata(opts);
	return result;
}

interface LlmTextAttemptResult {
	readonly result: LlmTextResult;
	readonly attempts: number;
	/** Raw, validated provider echo for hard-budget settlement. */
	readonly providerModelUsed: string | undefined;
}

/** Dispatch metadata used by hard-budget callers without changing core results. */
export async function runLlmTextWithAttemptMetadata(
	opts: LlmTextOptions
): Promise<LlmTextAttemptResult> {
	const sdkArgs =
		'messages' in opts ? { messages: opts.messages } : { prompt: opts.prompt, system: opts.system };
	const call = callShape(opts);
	const providerModelIdentity = captureProviderModelIdentity(modelForRequest(opts.model));
	const dispatched = await withLlmRetry(
		async () => {
			const finish = startRequest(opts.meter);
			try {
				const generated = await generateText({
					model: providerModelIdentity.model,
					temperature: opts.temperature,
					maxRetries: SDK_MAX_RETRIES,
					...limitArgs(call),
					...sdkArgs,
				});
				finish({ ...call.requestBase, outcome: 'ok', ...reported(generated.usage) });
				return generated;
			} catch (error) {
				finish({ ...call.requestBase, outcome: 'failed' });
				throw error;
			}
		},
		call.abortSignal,
		call.maxAttempts
	);
	const { text, usage } = dispatched.value;
	const providerModelUsed = providerModelIdentity.read();
	return {
		attempts: dispatched.attempts,
		providerModelUsed,
		result: {
			text,
			tokenUsage: normalizeUsage(usage),
			// Core attribution follows the requested model id, matching the object,
			// tools and stream dispatch paths. Provider echoes remain separate so
			// budget enforcement can detect reroutes without blanking core usage.
			modelUsed: call.modelUsed,
		},
	};
}

type LlmTextWithToolsOptions = {
	model: LanguageModel;
	messages: ModelMessage[];
	/** AI SDK tool set (built via `tool({...})`). The model may call these across
	 * up to `maxSteps` agentic steps before a final text answer. */
	tools: ToolSet;
	/** Max agentic steps before a forced stop. Defaults to {@link DEFAULT_MAX_TOOL_STEPS}. */
	maxSteps?: number;
	temperature?: number;
	maxOutputTokens?: number;
	abortSignal?: AbortSignal;
	/** Records each tool round as its own provider request. */
	meter?: LlmCallMeter;
};

/**
 * One-shot (non-streaming) tool-calling counterpart to {@link runLlmText}: the
 * model may call the supplied tools across up to `maxSteps` agentic steps, then
 * returns the final text. Same bounded-retry + usage normalization as the other
 * one-shot helpers. Use this (not `runLlmStream`) when you want a bounded
 * fetch-more loop but do NOT need token streaming to a user — e.g. the draft
 * step's `recallKnowledge` loop.
 *
 * Usage is the sum of every step that finished, in every attempt: the SDK's
 * `usage` is the last step's only, and a retried attempt paid for the steps it
 * finished before it failed. When the loop fails after a finished step, the
 * error is an `LlmPartialUsageError` carrying that usage (#1256). Each step is
 * one provider request on the meter; the step a failure interrupted is
 * recorded as a failed request with no reported usage.
 */
export async function runLlmTextWithTools(opts: LlmTextWithToolsOptions): Promise<LlmTextResult> {
	const call = callShape(opts);
	let spent: TokenUsage | undefined;
	let dispatched;
	try {
		dispatched = await withLlmRetry(
			async () => {
				let finishStep = startRequest(opts.meter);
				try {
					return await generateText({
						model: modelForRequest(opts.model),
						messages: opts.messages,
						tools: opts.tools,
						stopWhen: stepCountIs(opts.maxSteps ?? DEFAULT_MAX_TOOL_STEPS),
						temperature: opts.temperature,
						maxRetries: SDK_MAX_RETRIES,
						...limitArgs(call),
						onStepFinish: (step) => {
							spent = addTokenUsage(spent, normalizeUsage(step.usage));
							finishStep({ ...call.requestBase, outcome: 'ok', ...reported(step.usage) });
							finishStep = startRequest(opts.meter);
						},
					});
				} catch (error) {
					finishStep({ ...call.requestBase, outcome: 'failed' });
					throw error;
				}
			},
			call.abortSignal,
			call.maxAttempts
		);
	} catch (error) {
		throw withPartialUsage(error, spent, call.modelUsed);
	}
	const { text, totalUsage } = dispatched.value;
	return { text, tokenUsage: spent ?? normalizeUsage(totalUsage), modelUsed: call.modelUsed };
}

export interface LlmObjectOptions<S extends z.ZodTypeAny> {
	model: LanguageModel;
	schema: S;
	prompt: string;
	temperature?: number;
	/** Output ceiling (reasoning included); the task's ceiling applies when it is lower. */
	maxOutputTokens?: number;
	/**
	 * Cancel the call (and the backoff between its retries) mid-flight. The
	 * structured-output path was the one dispatch helper that could not honour a
	 * caller's deadline, which made every structured call — including the
	 * decision plane's language-backed adapter — uncancellable once dispatched.
	 */
	abortSignal?: AbortSignal;
	/** Lower the attempt ceiling below {@link MAX_LLM_ATTEMPTS} (see {@link LlmTextOptions}). */
	maxAttempts?: number;
	/** Records each attempt as its own provider request. */
	meter?: LlmCallMeter;
}

export interface LlmObjectResult<S extends z.ZodTypeAny> {
	object: z.infer<S>;
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
}

/**
 * The usage a failed `generateObject` call was billed for. A completion that
 * did not parse, did not match the schema or held no text throws
 * `NoObjectGeneratedError` with the usage of the call that returned it; every
 * other failure (a provider rejection, a network error, an abort) has none.
 */
function billedUsageOf(error: unknown): RawUsage {
	return NoObjectGeneratedError.isInstance(error) ? error.usage : undefined;
}

/**
 * One structured-output call: `generateObject` behind the shared retry policy.
 *
 * Usage is the sum of every attempt the provider billed (#1260). A completion
 * that fails the schema is paid for and then retried like any other failure, so
 * a success after two schema failures returns the usage of all three calls.
 * When the call fails for good after a billed attempt, the error is an
 * `LlmPartialUsageError` carrying that usage, with the last error as its cause
 * and message; a failure before any attempt was billed rethrows the original
 * error as is. Each attempt is one request on the meter, with its own usage.
 */
export async function runLlmObject<S extends z.ZodTypeAny>(
	opts: LlmObjectOptions<S>
): Promise<LlmObjectResult<S>> {
	const call = callShape(opts);
	let spent: TokenUsage | undefined;
	let dispatched;
	try {
		dispatched = await withLlmRetry(
			async () => {
				const finish = startRequest(opts.meter);
				try {
					const generated = await generateObject({
						model: modelForRequest(opts.model),
						schema: opts.schema,
						prompt: opts.prompt,
						temperature: opts.temperature,
						maxRetries: SDK_MAX_RETRIES,
						...limitArgs(call),
					});
					finish({ ...call.requestBase, outcome: 'ok', ...reported(generated.usage) });
					return generated;
				} catch (error) {
					const billed = billedUsageOf(error);
					spent = addTokenUsage(spent, normalizeUsage(billed));
					finish({ ...call.requestBase, outcome: 'failed', ...reported(billed) });
					throw error;
				}
			},
			call.abortSignal,
			call.maxAttempts
		);
	} catch (error) {
		throw withPartialUsage(error, spent, call.modelUsed);
	}
	const { object, usage } = dispatched.value;
	return {
		object: object as z.infer<S>,
		tokenUsage: addTokenUsage(spent, normalizeUsage(usage)),
		modelUsed: call.modelUsed,
	};
}
