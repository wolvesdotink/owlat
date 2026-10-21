/**
 * The embedding dispatch: every `embed()` call in the deployment
 * goes through {@link runEmbedding}, so each provider request is metered like
 * a language request and lands in the ledger as an `embedding` row. Embedding
 * calls wrote no ledger row before; a paid re-embed (D8) needs them to.
 *
 * Retries go through the shared retry policy, not the SDK's: the SDK's own
 * retries would hide requests from the meter, the way they did for language
 * calls before `lib/llm/dispatch.ts` switched them off. Runtime-neutral: the
 * knowledge retrieval seam runs in the V8 runtime.
 */

import { embed, type EmbeddingModel } from 'ai';
import type { TokenUsage } from '../../agent/steps/types';
import { withLlmRetry } from './retryPolicy';
import { startRequest, type LlmCallMeter } from './requestMeter';
import { callShape } from './callShape';
import { admitDispatch } from './dispatchAdmission';
import { utf8Bytes } from './admissionPort';

const SDK_MAX_RETRIES = 0;

export interface EmbeddingOptions {
	readonly model: EmbeddingModel;
	readonly value: string;
	readonly abortSignal?: AbortSignal;
	/** Records each provider request; its task (`embedding.*`) sets the deadline. */
	readonly meter?: LlmCallMeter;
}

export interface EmbeddingResult {
	readonly embedding: number[];
	readonly tokenUsage: TokenUsage | undefined;
	readonly modelUsed: string;
}

/** Input tokens as the ledger's usage triple; an embedding has no output. */
function embeddingUsage(tokens: number | undefined): TokenUsage | undefined {
	if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined;
	return { promptTokens: tokens, completionTokens: 0, totalTokens: tokens };
}

/** Embed one value, metering every provider request. */
export async function runEmbedding(opts: EmbeddingOptions): Promise<EmbeddingResult> {
	// An embedding has no output to cap; the shape gives the deadline, the
	// attempt allowance, and the request fields (a local embedder is free).
	const call = callShape({
		model: opts.model,
		...(opts.meter ? { meter: opts.meter } : {}),
		...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
	});
	// Spend admission before the first request.
	const hold = await admitDispatch(opts.meter, call, {
		plane: 'embedding',
		hasOutput: false,
		isIncremental: true,
	});
	let dispatched;
	try {
		dispatched = await withLlmRetry(
			async () => {
				// Each attempt is one request, reserved before it is sent.
				await hold.beforeRequest({ bytes: utf8Bytes(opts.value), messages: 1 });
				const finish = startRequest(opts.meter);
				try {
					const result = await embed({
						model: opts.model,
						value: opts.value,
						maxRetries: SDK_MAX_RETRIES,
						...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
					});
					const usage = embeddingUsage(result.usage?.tokens);
					finish({ ...call.requestBase, outcome: 'ok', ...(usage ? { usage } : {}) });
					return result;
				} catch (error) {
					finish({ ...call.requestBase, outcome: 'failed' });
					throw error;
				}
			},
			call.abortSignal,
			call.maxAttempts
		);
	} finally {
		await hold.end();
	}
	return {
		embedding: dispatched.value.embedding,
		tokenUsage: embeddingUsage(dispatched.value.usage?.tokens),
		modelUsed: call.modelUsed,
	};
}
