'use node';

/**
 * Shared LLM dispatch for every LLM call in the deployment. Owns the one
 * mapping between the AI SDK's `usage` shape and the lifecycle's TokenUsage
 * validator (`./providerUsage.ts`) — adding or rotating SDKs touches one place.
 *
 * Lifted from agent/steps/shared/llm.ts to a
 * shared location so non-agent callers (translate, knowledge/extraction,
 * files/processing, visualizationAgent) can use the same surface.
 *
 * METERING. Every helper takes an optional {@link LlmCallMeter} and
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
import { isLengthStop, LlmTruncatedError } from './truncation';
import { DEFAULT_MAX_TOOL_STEPS } from './dispatchStream';
import { admissionRefusalOf, dispatchRequestSize } from './admissionPort';
import { admitDispatch, isWrappableModel } from './dispatchAdmission';
import { toolRoundLimit } from './taskLimits';

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
	/** The output stopped at its ceiling: the text is incomplete (`./truncation.ts`). */
	isTruncated?: boolean;
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
	// Spend admission before each provider request.
	const requestModel = modelForRequest(opts.model);
	const hold = await admitDispatch(opts.meter, call, {
		isIncremental: isWrappableModel(requestModel),
		size: dispatchRequestSize(opts),
	});
	const providerModelIdentity = captureProviderModelIdentity(hold.wrap(requestModel));
	let dispatched;
	try {
		dispatched = await withLlmRetry(
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
					// A request admission refused was never sent.
					if (!admissionRefusalOf(error)) finish({ ...call.requestBase, outcome: 'failed' });
					throw error;
				}
			},
			call.abortSignal,
			call.maxAttempts
		);
	} finally {
		await hold.end();
	}
	const { text, usage, finishReason } = dispatched.value;
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
			isTruncated: isLengthStop(finishReason),
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
 * error is an `LlmPartialUsageError` carrying that usage. Each step is
 * one provider request on the meter; the step a failure interrupted is
 * recorded as a failed request with no reported usage.
 */
export async function runLlmTextWithTools(opts: LlmTextWithToolsOptions): Promise<LlmTextResult> {
	const call = callShape(opts);
	let spent: TokenUsage | undefined;
	let dispatched;
	// The caller's step limit, capped by the task's tool rounds (Phase 5).
	const maxSteps = toolRoundLimit(opts.meter?.task, opts.maxSteps ?? DEFAULT_MAX_TOOL_STEPS);
	const requestModel = modelForRequest(opts.model);
	const hold = await admitDispatch(opts.meter, call, {
		size: dispatchRequestSize({ messages: opts.messages, tools: opts.tools }),
		steps: maxSteps,
		isIncremental: isWrappableModel(requestModel),
	});
	const toolModel = hold.wrap(requestModel);
	try {
		dispatched = await withLlmRetry(
			async () => {
				let finishStep = startRequest(opts.meter);
				try {
					return await generateText({
						model: toolModel,
						messages: opts.messages,
						tools: opts.tools,
						stopWhen: stepCountIs(maxSteps),
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
					// A step admission refused was never sent.
					if (!admissionRefusalOf(error)) finishStep({ ...call.requestBase, outcome: 'failed' });
					throw error;
				}
			},
			call.abortSignal,
			call.maxAttempts
		);
	} catch (error) {
		throw withPartialUsage(error, spent, call.modelUsed);
	} finally {
		await hold.end();
	}
	const { text, totalUsage, finishReason } = dispatched.value;
	return {
		text,
		tokenUsage: spent ?? normalizeUsage(totalUsage),
		modelUsed: call.modelUsed,
		isTruncated: isLengthStop(finishReason),
	};
}

export type LlmObjectOptions<S extends z.ZodTypeAny> = LlmObjectInput & LlmObjectSettings<S>;

/**
 * One prompt, or messages: a prompt split into a cache-marked system message
 * and the per-message content (`promptCache.ts`, L9).
 */
type LlmObjectInput =
	| { prompt: string; messages?: never }
	| { messages: ModelMessage[]; prompt?: never };

interface LlmObjectSettings<S extends z.ZodTypeAny> {
	model: LanguageModel;
	schema: S;
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
 * Usage is the sum of every attempt the provider billed. A completion
 * that fails the schema is paid for and then retried like any other failure, so
 * a success after two schema failures returns the usage of all three calls.
 * When the call fails for good after a billed attempt, the error is an
 * `LlmPartialUsageError` carrying that usage, with the last error as its cause
 * and message; a failure before any attempt was billed rethrows the original
 * error as is. Each attempt is one request on the meter, with its own usage.
 * An object that stopped at its output ceiling throws an `LlmTruncatedError`
 * (wrapped with its usage), never a result.
 */
export async function runLlmObject<S extends z.ZodTypeAny>(
	opts: LlmObjectOptions<S>
): Promise<LlmObjectResult<S>> {
	const call = callShape(opts);
	let spent: TokenUsage | undefined;
	let dispatched;
	const requestModel = modelForRequest(opts.model);
	const hold = await admitDispatch(opts.meter, call, {
		isIncremental: isWrappableModel(requestModel),
		size: dispatchRequestSize({ prompt: opts.prompt, schema: opts.schema }),
	});
	const objectModel = hold.wrap(requestModel);
	try {
		dispatched = await withLlmRetry(
			async () => {
				const finish = startRequest(opts.meter);
				try {
					const generated = await generateObject({
						model: objectModel,
						schema: opts.schema,
						...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
						temperature: opts.temperature,
						maxRetries: SDK_MAX_RETRIES,
						...limitArgs(call),
					});
					finish({ ...call.requestBase, outcome: 'ok', ...reported(generated.usage) });
					return generated;
				} catch (error) {
					// A request admission refused was never sent.
					if (admissionRefusalOf(error)) throw error;
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
	} finally {
		await hold.end();
	}
	const { object, usage, finishReason } = dispatched.value;
	const tokenUsage = addTokenUsage(spent, normalizeUsage(usage));
	// A schema-valid object that stopped at its output ceiling is incomplete: a
	// verdict, a score or a list cut short. It is never returned as a result.
	// Thrown after the request is on the meter, as a failure every structured
	// caller already handles; the error carries the billed usage. Not retried:
	// the same request would stop at the same ceiling.
	if (isLengthStop(finishReason)) {
		throw withPartialUsage(new LlmTruncatedError('structured output'), tokenUsage, call.modelUsed);
	}
	return { object: object as z.infer<S>, tokenUsage, modelUsed: call.modelUsed };
}
