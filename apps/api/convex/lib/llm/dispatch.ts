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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an LLM call with bounded exponential backoff, retrying only transient
 * failures. The single retry choke point for every dispatch helper.
 */
interface LlmRetryResult<T> {
	readonly value: T;
	readonly attempts: number;
}

async function withLlmRetry<T>(run: () => Promise<T>): Promise<LlmRetryResult<T>> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt++) {
		try {
			return { value: await run(), attempts: attempt + 1 };
		} catch (error) {
			lastError = error;
			if (!isRetriableLlmError(error) || attempt === MAX_LLM_ATTEMPTS - 1) throw error;
			await sleep(LLM_BACKOFF_BASE_MS * 2 ** attempt);
		}
	}
	throw lastError;
}

export type LlmTextInput = { messages: ModelMessage[] } | { prompt: string; system?: string };

export type LlmTextOptions = LlmTextInput & {
	model: LanguageModel;
	temperature?: number;
	maxOutputTokens?: number;
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
}

/** Dispatch metadata used by hard-budget callers without changing core results. */
export async function runLlmTextWithAttemptMetadata(
	opts: LlmTextOptions
): Promise<LlmTextAttemptResult> {
	const sdkArgs =
		'messages' in opts ? { messages: opts.messages } : { prompt: opts.prompt, system: opts.system };
	const dispatched = await withLlmRetry(() =>
		generateText({
			model: opts.model,
			temperature: opts.temperature,
			...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
			...sdkArgs,
		})
	);
	const { text, usage } = dispatched.value;
	return {
		attempts: dispatched.attempts,
		result: {
			text,
			tokenUsage: normalizeUsage(usage),
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
