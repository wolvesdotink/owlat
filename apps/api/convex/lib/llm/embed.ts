/**
 * The embedding dispatch (ADR-0073): every `embed()` call in the deployment
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
import { dispatchLimits } from './taskLimits';
import { taskPolicy } from './taskPolicy';
import { modelEndpoint } from './modelEndpoint';

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

function embeddingModelId(model: EmbeddingModel): string {
	return typeof model === 'string' ? model : model.modelId;
}

/** Input tokens as the ledger's usage triple; an embedding has no output. */
function embeddingUsage(tokens: number | undefined): TokenUsage | undefined {
	if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined;
	return { promptTokens: tokens, completionTokens: 0, totalTokens: tokens };
}

/** Embed one value, metering every provider request. */
export async function runEmbedding(opts: EmbeddingOptions): Promise<EmbeddingResult> {
	const limits = dispatchLimits({
		task: opts.meter?.task,
		root: opts.meter?.root,
		abortSignal: opts.abortSignal,
	});
	const modelUsed = embeddingModelId(opts.model);
	const endpoint = modelEndpoint(opts.model);
	const requestBase = { modelUsed, ...(endpoint ? { endpoint } : {}) };
	const maxAttempts = opts.meter?.task ? taskPolicy(opts.meter.task).maxAttempts : undefined;
	const dispatched = await withLlmRetry(
		async () => {
			const finish = startRequest(opts.meter);
			try {
				const result = await embed({
					model: opts.model,
					value: opts.value,
					maxRetries: SDK_MAX_RETRIES,
					...(limits.abortSignal ? { abortSignal: limits.abortSignal } : {}),
				});
				const usage = embeddingUsage(result.usage?.tokens);
				finish({ ...requestBase, outcome: 'ok', ...(usage ? { usage } : {}) });
				return result;
			} catch (error) {
				finish({ ...requestBase, outcome: 'failed' });
				throw error;
			}
		},
		limits.abortSignal,
		maxAttempts
	);
	return {
		embedding: dispatched.value.embedding,
		tokenUsage: embeddingUsage(dispatched.value.usage?.tokens),
		modelUsed,
	};
}
