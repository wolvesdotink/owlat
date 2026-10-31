'use node';

/**
 * The streaming, tool-calling dispatch (split out of `./dispatch.ts`, which
 * re-exports it). Metering is at the provider boundary (`./streamMetering.ts`):
 * every request the SDK makes, a re-sent opening request and each tool round
 * included, is one request on the meter, with the usage the provider reported
 * whether or not the reader's callbacks got that far. The meter's task sets
 * the output ceiling, the deadline and the retry allowance (`./callShape.ts`).
 */

import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { TokenUsage } from '../../agent/steps/types';
import { modelForRequest } from './requestPolicy';
import { MAX_LLM_ATTEMPTS } from './retryPolicy';
import { withPartialUsage } from './partialUsage';
import { addTokenUsage } from './tokenUsage';
import { streamUsage, usageDetails } from './providerUsage';
import type { LlmCallMeter } from './requestMeter';
import { callShape, limitArgs, type CallShape } from './callShape';
import { dispatchRequestSize } from './admissionPort';
import { admitDispatch, isWrappableModel, type DispatchHold } from './dispatchAdmission';

import { meterStreamModel, STREAM_SETTLE_MS } from './streamMetering';
import { isLengthStop } from './truncation';
import { toolRoundLimit } from './taskLimits';

/**
 * Default ceiling on agentic steps (one LLM call + its tool round-trip) per
 * streamed turn. Caps runaway tool loops and bounds per-turn spend — the engine
 * passes its own value but never above a sane hard limit.
 */
export const DEFAULT_MAX_TOOL_STEPS = 8;

interface LlmStreamToolCall {
	toolCallId: string;
	toolName: string;
	input: unknown;
}
interface LlmStreamToolResult {
	toolCallId: string;
	toolName: string;
	output: unknown;
}
interface LlmStreamToolError {
	toolCallId: string;
	toolName: string;
	error: unknown;
}

interface LlmStreamOptions {
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
	/** Output ceiling (reasoning included); the task's ceiling applies when it is lower. */
	maxOutputTokens?: number;
	/** Records each stream step as its own provider request. */
	meter?: LlmCallMeter;
	/**
	 * Keep only the text of the final step, the way `generateText().text` does,
	 * for a caller whose result is a document body rather than a chat
	 * transcript. Without it, narration the model writes before a tool call
	 * ("Let me check availability…") is joined to the reply after it. The
	 * accumulated text is reset when a step starts and when a tool call arrives,
	 * and `onTextDelta` then fires with the empty text so a live view drops it.
	 */
	finalStepOnly?: boolean;
	/** Called for each text chunk with the FULL accumulated text and the delta. */
	onTextDelta?: (fullText: string, delta: string) => void | Promise<void>;
	/** Called when the model requests a tool (before it executes). */
	onToolCall?: (call: LlmStreamToolCall) => void | Promise<void>;
	/** Called when a tool returns a result. */
	onToolResult?: (result: LlmStreamToolResult) => void | Promise<void>;
	/** Called when a tool's execute throws (non-fatal; the model may recover). */
	onToolError?: (error: LlmStreamToolError) => void | Promise<void>;
}

interface LlmStreamResult {
	text: string;
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
	finishReason: string | undefined;
	/** True when the caller's abortSignal ended the stream before a natural finish. */
	aborted: boolean;
	/** The output stopped at its ceiling: the text is incomplete (`./truncation.ts`). */
	isTruncated?: boolean;
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
 * The SDK's default retry is kept here on purpose: it only re-sends the opening
 * request, before any token exists, and it is the stream's only retry.
 * Stream errors surface as a thrown error (after any prior text deltas were
 * delivered) for the caller to persist as a `error`/`stopped` message. A
 * failure after a finished step throws an `LlmPartialUsageError` carrying the
 * usage of the finished steps, and an aborted stream returns that usage:
 * those steps were billed either way.
 */
/** The stream's step limit: the caller's, capped by its task's tool rounds (Phase 5). */
function maxStepsOf(opts: LlmStreamOptions): number {
	return toolRoundLimit(opts.meter?.task, opts.maxSteps ?? DEFAULT_MAX_TOOL_STEPS);
}

export async function runLlmStream(opts: LlmStreamOptions): Promise<LlmStreamResult> {
	const call = callShape(opts);
	// Spend admission before the opening request: every
	// step, and the re-sends of the opening request the SDK may make.
	const requestModel = modelForRequest(opts.model);
	const hold = await admitDispatch(opts.meter, call, {
		size: dispatchRequestSize({
			...(opts.system !== undefined ? { system: opts.system } : {}),
			messages: opts.messages,
			...(opts.tools ? { tools: opts.tools } : {}),
		}),
		steps: maxStepsOf(opts),
		retries: 'opening_only',
		isIncremental: isWrappableModel(requestModel),
	});
	try {
		return await streamOnce(opts, call, requestModel, hold);
	} finally {
		await hold.end();
	}
}

async function streamOnce(
	opts: LlmStreamOptions,
	call: CallShape,
	requestModel: LanguageModel,
	hold: DispatchHold
): Promise<LlmStreamResult> {
	const metered = meterStreamModel(requestModel, opts.meter, call.requestBase);
	// Ends the provider stream when the read stops early (a callback threw), so
	// nothing is generated, and billed, for a reader that has gone.
	const readerGone = new AbortController();
	const signal = call.abortSignal
		? AbortSignal.any([call.abortSignal, readerGone.signal])
		: readerGone.signal;
	const result = streamText({
		// Admission outside the meter: a request it refuses is never opened.
		model: hold.wrap(metered.model),
		...(opts.system !== undefined ? { system: opts.system } : {}),
		messages: opts.messages,
		...(opts.tools ? { tools: opts.tools } : {}),
		stopWhen: stepCountIs(maxStepsOf(opts)),
		temperature: opts.temperature,
		// The SDK's retry re-sends only the opening request, before any token
		// exists; the task's attempt allowance bounds it, and each re-send is
		// metered above.
		maxRetries: (call.maxAttempts ?? MAX_LLM_ATTEMPTS) - 1,
		...limitArgs({ maxOutputTokens: call.maxOutputTokens, abortSignal: signal }),
	});

	let text = '';
	let tokenUsage: TokenUsage | undefined;
	// Finished steps as the reader saw them (a model the meter cannot wrap).
	let stepsSpent: TokenUsage | undefined;
	let finishReason: string | undefined;
	let aborted = false;
	const resetText = async (): Promise<void> => {
		if (!opts.finalStepOnly || text === '') return;
		text = '';
		await opts.onTextDelta?.(text, '');
	};
	/** What the provider billed so far: its own reports when metered at the boundary. */
	const billed = () => (metered.isProviderLevel ? metered.spent() : stepsSpent);

	try {
		for await (const part of result.fullStream) {
			switch (part.type) {
				case 'start-step':
					await resetText();
					break;
				case 'text-delta':
					text += part.text;
					await opts.onTextDelta?.(text, part.text);
					break;
				case 'tool-call':
					await resetText();
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
				case 'finish-step':
					stepsSpent = addTokenUsage(stepsSpent, streamUsage(part.usage));
					if (!metered.isProviderLevel) {
						const stepUsage = streamUsage(part.usage);
						opts.meter?.record({
							...call.requestBase,
							outcome: 'ok',
							latencyMs: 0,
							...(stepUsage ? { usage: stepUsage } : {}),
							...usageDetails(part.usage),
						});
					}
					break;
				case 'finish':
					finishReason = part.finishReason;
					tokenUsage = streamUsage(part.totalUsage);
					break;
				case 'abort':
					aborted = true;
					break;
				case 'error':
					// Surface the failure once any preceding text has been delivered.
					throw part.error;
			}
		}
	} catch (error) {
		// Let a request the provider already finished report its usage, then stop
		// the stream nobody reads.
		await metered.settle(STREAM_SETTLE_MS);
		readerGone.abort();
		metered.closeOpen();
		if (!metered.isProviderLevel) {
			opts.meter?.record({ ...call.requestBase, outcome: 'failed', latencyMs: 0 });
		}
		throw withPartialUsage(error, billed(), call.modelUsed);
	}
	// A request an abort cut short was made too, with no usage reported.
	await metered.settle(STREAM_SETTLE_MS);
	metered.closeOpen();

	return {
		text,
		tokenUsage: tokenUsage ?? billed(),
		modelUsed: call.modelUsed,
		finishReason,
		aborted,
		isTruncated: isLengthStop(finishReason),
	};
}
