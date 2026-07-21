'use node';

/**
 * Shared LLM dispatch for every LLM call in the deployment. Owns the one
 * mapping between the AI SDK's `usage` shape and the lifecycle's TokenUsage
 * validator — adding or rotating SDKs touches one file.
 *
 * Per ADR-0029: lifted from agent/steps/shared/llm.ts (ADR-0014 seam) to a
 * shared location so non-agent callers (translate, knowledge/extraction,
 * semanticFileProcessing, visualizationAgent) can use the same surface.
 *
 * AI SDK field-name history: 4.x had `promptTokens/completionTokens`;
 * 5.x rotated to `inputTokens/outputTokens`. normalizeUsage() is the
 * single site that absorbs any future rotation.
 */

import {
	generateObject,
	generateText,
	streamText,
	stepCountIs,
	wrapLanguageModel,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
} from 'ai';
import type { z } from 'zod';
import type { TokenUsage } from '../../agent/steps/types';
import { MAX_LLM_ATTEMPTS } from './retryPolicy';

export { MAX_LLM_ATTEMPTS } from './retryPolicy';

type RawUsage =
	| {
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
	  }
	| undefined;

export function normalizeUsage(usage: RawUsage): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		promptTokens: usage.inputTokens ?? 0,
		completionTokens: usage.outputTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

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

const LLM_BACKOFF_BASE_MS = 500;

/** Best-effort HTTP status off an AI-SDK / fetch error shape. */
function errorStatus(error: unknown): number | undefined {
	const e = error as {
		statusCode?: number;
		status?: number;
		response?: { status?: number };
	} | null;
	return e?.statusCode ?? e?.status ?? e?.response?.status;
}

/**
 * Whether an LLM call error is worth retrying. Transient — rate limits (429),
 * server/overload (5xx, "overloaded"), timeouts, network resets — retry with
 * backoff. Hard client errors — bad/expired API key (401/403), malformed
 * request (400/404/422) — are NOT retriable: bail immediately so a misconfigured
 * key doesn't burn the whole attempt budget (and, upstream, a whole pipeline
 * retry) the way a transient overload would. Ambiguous errors default to
 * retriable (treated as a transient network blip).
 */
export function isRetriableLlmError(error: unknown): boolean {
	const status = errorStatus(error);
	if (status !== undefined) {
		if (status === 408 || status === 409 || status === 429) return true;
		if (status >= 500) return true;
		if (status >= 400) return false; // 401/403/400/404/422 → don't retry
	}
	const message = String((error as { message?: unknown } | null)?.message ?? error).toLowerCase();
	if (
		/\b(400|401|403|404|422)\b|invalid.?api.?key|unauthor|forbidden|authentication|invalid request|bad request|not found/.test(
			message
		)
	) {
		return false;
	}
	return true;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
	if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
	assertNotAborted(abortSignal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			abortSignal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortSignal?.reason ?? new Error('LLM dispatch aborted'));
		}
		abortSignal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Run an LLM call with bounded exponential backoff, retrying only transient
 * failures. The single retry choke point for every dispatch helper.
 */
interface LlmRetryResult<T> {
	readonly value: T;
	readonly attempts: number;
}

async function withLlmRetry<T>(
	run: () => Promise<T>,
	abortSignal?: AbortSignal
): Promise<LlmRetryResult<T>> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
		assertNotAborted(abortSignal);
		try {
			return { value: await run(), attempts: attempt + 1 };
		} catch (error) {
			assertNotAborted(abortSignal);
			lastError = error;
			if (!isRetriableLlmError(error) || attempt === MAX_LLM_ATTEMPTS - 1) throw error;
			await sleep(LLM_BACKOFF_BASE_MS * 2 ** attempt, abortSignal);
		}
	}
	throw lastError;
}

function assertNotAborted(abortSignal: AbortSignal | undefined): void {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('LLM dispatch aborted');
}

export type LlmTextInput = { messages: ModelMessage[] } | { prompt: string; system?: string };

export type LlmTextOptions = LlmTextInput & {
	model: LanguageModel;
	temperature?: number;
	maxOutputTokens?: number;
	abortSignal?: AbortSignal;
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

export interface LlmTextAttemptResult {
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
	const providerModelIdentity = captureProviderModelIdentity(opts.model);
	const dispatched = await withLlmRetry(
		() =>
			generateText({
				model: providerModelIdentity.model,
				temperature: opts.temperature,
				...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
				...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
				...sdkArgs,
			}),
		opts.abortSignal
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
			modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
		},
	};
}

export type LlmTextWithToolsOptions = {
	model: LanguageModel;
	messages: ModelMessage[];
	/** AI SDK tool set (built via `tool({...})`). The model may call these across
	 * up to `maxSteps` agentic steps before a final text answer. */
	tools: ToolSet;
	/** Max agentic steps before a forced stop. Defaults to {@link DEFAULT_MAX_TOOL_STEPS}. */
	maxSteps?: number;
	temperature?: number;
};

/**
 * One-shot (non-streaming) tool-calling counterpart to {@link runLlmText}: the
 * model may call the supplied tools across up to `maxSteps` agentic steps, then
 * returns the final text. Same bounded-retry + usage normalization as the other
 * one-shot helpers. Use this (not {@link runLlmStream}) when you want a bounded
 * fetch-more loop but do NOT need token streaming to a user — e.g. the draft
 * step's `recallKnowledge` loop.
 */
export async function runLlmTextWithTools(opts: LlmTextWithToolsOptions): Promise<LlmTextResult> {
	const dispatched = await withLlmRetry(() =>
		generateText({
			model: opts.model,
			messages: opts.messages,
			tools: opts.tools,
			stopWhen: stepCountIs(opts.maxSteps ?? DEFAULT_MAX_TOOL_STEPS),
			temperature: opts.temperature,
		})
	);
	const { text, usage } = dispatched.value;
	return {
		text,
		tokenUsage: normalizeUsage(usage),
		modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
	};
}

export interface LlmObjectOptions<S extends z.ZodTypeAny> {
	model: LanguageModel;
	schema: S;
	prompt: string;
	temperature?: number;
}

export interface LlmObjectResult<S extends z.ZodTypeAny> {
	object: z.infer<S>;
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
}

export async function runLlmObject<S extends z.ZodTypeAny>(
	opts: LlmObjectOptions<S>
): Promise<LlmObjectResult<S>> {
	const dispatched = await withLlmRetry(() =>
		generateObject({
			model: opts.model,
			schema: opts.schema,
			prompt: opts.prompt,
			temperature: opts.temperature,
		})
	);
	const { object, usage } = dispatched.value;
	return {
		object: object as z.infer<S>,
		tokenUsage: normalizeUsage(usage),
		modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
	};
}

/**
 * Default ceiling on agentic steps (one LLM call + its tool round-trip) per
 * streamed turn. Caps runaway tool loops and bounds per-turn spend — the engine
 * passes its own value but never above a sane hard limit.
 */
export const DEFAULT_MAX_TOOL_STEPS = 8;

export interface LlmStreamToolCall {
	toolCallId: string;
	toolName: string;
	input: unknown;
}
export interface LlmStreamToolResult {
	toolCallId: string;
	toolName: string;
	output: unknown;
}
export interface LlmStreamToolError {
	toolCallId: string;
	toolName: string;
	error: unknown;
}

export interface LlmStreamOptions {
	model: LanguageModel;
	system?: string;
	messages: ModelMessage[];
	/** AI SDK tool set (built via `tool({...})`). Omit for a tool-free turn. */
	tools?: ToolSet;
	/** Max agentic steps before forced stop. Defaults to {@link DEFAULT_MAX_TOOL_STEPS}. */
	maxSteps?: number;
	temperature?: number;
	/** Abort the stream mid-flight (user "stop generating"). */
	abortSignal?: AbortSignal;
	/** Called for each text chunk with the FULL accumulated text and the delta. */
	onTextDelta?: (fullText: string, delta: string) => void | Promise<void>;
	/** Called when the model requests a tool (before it executes). */
	onToolCall?: (call: LlmStreamToolCall) => void | Promise<void>;
	/** Called when a tool returns a result. */
	onToolResult?: (result: LlmStreamToolResult) => void | Promise<void>;
	/** Called when a tool's execute throws (non-fatal; the model may recover). */
	onToolError?: (error: LlmStreamToolError) => void | Promise<void>;
}

export interface LlmStreamResult {
	text: string;
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
	finishReason: string | undefined;
	/** True when the caller's abortSignal ended the stream before a natural finish. */
	aborted: boolean;
}

/**
 * Streaming, tool-calling counterpart to {@link runLlmText} — the single seam
 * the AI assistant + @assistant-in-chat engine drives. Consumes the AI SDK
 * `fullStream`, accumulating text and surfacing tool calls/results to the caller
 * via callbacks so it can persist partial state (throttled row-append) and tool
 * cards as they happen. Returns the final text + usage on a natural finish.
 *
 * Not retried: unlike the one-shot helpers, a stream may already have emitted
 * tokens to the user, so a silent retry would duplicate output and double-charge.
 * Stream errors surface as a thrown error (after any prior text deltas were
 * delivered) for the caller to persist as a `error`/`stopped` message.
 */
export async function runLlmStream(opts: LlmStreamOptions): Promise<LlmStreamResult> {
	const result = streamText({
		model: opts.model,
		...(opts.system !== undefined ? { system: opts.system } : {}),
		messages: opts.messages,
		...(opts.tools ? { tools: opts.tools } : {}),
		stopWhen: stepCountIs(opts.maxSteps ?? DEFAULT_MAX_TOOL_STEPS),
		temperature: opts.temperature,
		...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
	});

	let text = '';
	let tokenUsage: TokenUsage | undefined;
	let finishReason: string | undefined;
	let aborted = false;

	for await (const part of result.fullStream) {
		switch (part.type) {
			case 'text-delta':
				text += part.text;
				await opts.onTextDelta?.(text, part.text);
				break;
			case 'tool-call':
				await opts.onToolCall?.({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.input,
				});
				break;
			case 'tool-result':
				await opts.onToolResult?.({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					output: part.output,
				});
				break;
			case 'tool-error':
				await opts.onToolError?.({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					error: part.error,
				});
				break;
			case 'finish': {
				finishReason = part.finishReason;
				const u = part.totalUsage;
				const input = u.inputTokens ?? 0;
				const output = u.outputTokens ?? 0;
				tokenUsage = {
					promptTokens: input,
					completionTokens: output,
					totalTokens: u.totalTokens ?? input + output,
				};
				break;
			}
			case 'abort':
				aborted = true;
				break;
			case 'error':
				// Surface the failure once any preceding text has been delivered.
				throw part.error;
		}
	}

	return {
		text,
		tokenUsage,
		modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
		finishReason,
		aborted,
	};
}
