'use node';

/**
 * The model side of the batch path (ADR-0073, L14). A batch request must be the
 * request the real-time call would have sent, and its result must be read the
 * way the real-time call reads it. Both go through the real structured-output
 * dispatch (`runLlmObject`) on a model built exactly as the resolver builds it
 * (`lib/llmProviders/openai.ts`, `anthropic.ts`: the native client, no base URL)
 * but with an in-process `fetch`:
 *
 *   - CAPTURE: the fetch keeps the request the SDK made (URL, JSON body, the
 *     Anthropic beta header) and answers 400, so nothing leaves the process.
 *     The task's output ceiling, the schema mode and every other wire field
 *     are what the dispatch sends in real time.
 *   - REPLAY: the fetch answers with the batch's result body, so the SDK
 *     parses the provider's response, its usage included, as it would have.
 *
 * Neither meter is admitted or written: the batch request was held and is
 * written by `aiRouting/batchItems.ts`, from the replayed request.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { ActionCtx } from '../../../_generated/server';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { resolveAiConfig } from '../../llmProvider';
import { isLocalModel, modelEndpoint } from '../modelEndpoint';
import { runLlmObject } from '../dispatch';
import { LlmCallMeter, type LlmRequestRecord } from '../requestMeter';
import { LlmPartialUsageError } from '../partialUsage';
import { LlmTruncatedError } from '../truncation';
import { BATCH_PROVIDERS, type BatchProvider } from '../../validators/aiRouting';
import type { CapturedRequest } from './wire';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A batch-capable model of the current language plane, with the key its batch calls need. */
export interface BatchRoute {
	readonly provider: BatchProvider;
	readonly apiKey: string;
	readonly modelId: string;
}

function isBatchProvider(endpoint: string | undefined): endpoint is BatchProvider {
	return (BATCH_PROVIDERS as readonly string[]).includes(endpoint ?? '');
}

/**
 * The batch route for `model` (the model the real-time call resolved), or null
 * when its adapter has no batch API Owlat speaks: anything but the native
 * OpenAI and Anthropic endpoints, a local model, or a plane that moved since
 * the model was resolved.
 */
export async function batchRouteFor(
	ctx: ActionCtx,
	model: LanguageModel
): Promise<BatchRoute | null> {
	const provider = modelEndpoint(model);
	if (!isBatchProvider(provider) || isLocalModel(model) || typeof model === 'string') return null;
	const { language } = await resolveAiConfig(ctx);
	const apiKey = language.clientConfig.apiKey;
	if (language.endpointProvenance !== provider || language.clientConfig.baseUrl || !apiKey) {
		return null;
	}
	if (language.models.fast !== model.modelId && language.models.capable !== model.modelId) {
		return null;
	}
	return { provider, apiKey, modelId: model.modelId };
}

/** The model the adapters build for `route`, with `fetchImpl` in place of the network. */
function routeModel(route: BatchRoute, fetchImpl: Fetch): LanguageModel {
	return route.provider === 'openai-native'
		? createOpenAI({ apiKey: route.apiKey, fetch: fetchImpl })(route.modelId)
		: createAnthropic({ apiKey: route.apiKey, fetch: fetchImpl })(route.modelId);
}

/** What one structured call sends: everything but the model. */
export interface ObjectCallInput<S extends z.ZodTypeAny> {
	readonly task: AiTaskName;
	readonly schema: S;
	readonly prompt: string;
	readonly temperature?: number;
}

function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const value = new Headers(headers).get(name);
	return value ?? undefined;
}

/** The request the real-time structured call would send, captured in process. */
export async function captureObjectRequest<S extends z.ZodTypeAny>(
	route: BatchRoute,
	input: ObjectCallInput<S>
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const fetchImpl: Fetch = async (url, init) => {
		const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		if (body && typeof body === 'object' && captured === undefined) {
			const betaHeader = headerOf(init?.headers, 'anthropic-beta');
			captured = {
				url: String(url),
				body: body as Record<string, unknown>,
				...(betaHeader ? { betaHeader } : {}),
			};
		}
		return new Response(JSON.stringify({ error: { message: 'captured' } }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	};
	await runLlmObject({
		model: routeModel(route, fetchImpl),
		schema: input.schema,
		prompt: input.prompt,
		...(input.temperature === undefined ? {} : { temperature: input.temperature }),
		maxAttempts: 1,
		meter: new LlmCallMeter({ task: input.task, hasOuterHold: true }),
	}).catch(() => undefined);
	if (!captured) throw new Error('The structured call made no request to capture.');
	return captured;
}

/** A batch result read back. `request` is the billed request as the dispatch records it. */
export type ReplayedResult<S extends z.ZodTypeAny> =
	| {
			readonly outcome: 'succeeded';
			readonly object: z.infer<S>;
			readonly request?: LlmRequestRecord;
	  }
	| { readonly outcome: 'truncated' | 'invalid'; readonly request?: LlmRequestRecord };

/** Read a succeeded batch result's body as the real-time call reads its response. */
export async function replayObjectResult<S extends z.ZodTypeAny>(
	route: BatchRoute,
	input: Omit<ObjectCallInput<S>, 'prompt'>,
	body: unknown
): Promise<ReplayedResult<S>> {
	const fetchImpl: Fetch = async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	const meter = new LlmCallMeter({ task: input.task, hasOuterHold: true });
	try {
		const result = await runLlmObject({
			model: routeModel(route, fetchImpl),
			schema: input.schema,
			// The response is fixed; the prompt only has to be a valid one.
			prompt: 'Batch result.',
			...(input.temperature === undefined ? {} : { temperature: input.temperature }),
			maxAttempts: 1,
			meter,
		});
		return { outcome: 'succeeded', object: result.object, request: meter.requests[0] };
	} catch (error) {
		const cause = error instanceof LlmPartialUsageError ? error.cause : error;
		const isTruncated = cause instanceof LlmTruncatedError;
		return { outcome: isTruncated ? 'truncated' : 'invalid', request: meter.requests[0] };
	}
}
