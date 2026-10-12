/**
 * Admission for a batch of paid embedding calls (ADR-0073, D8 and Phase 1b):
 * the implementation behind the embed lane's seam
 * (`lib/aiRouting/embeddingAdmission.ts` `PaidEmbeddingAdmission`), which an
 * admin-started re-embed, rebuild, validation or sample check asks before it
 * resolves an embedder.
 *
 * One hold covers the whole batch: every text, every attempt, at the model's
 * embedding price. The batch's calls are metered with the hold's id on their
 * rows (`reservationId` on the meter's target, so the dispatch reserves
 * nothing more), and `settle` closes the hold against those rows once the
 * batch is over: zero calls releases it, and a batch whose rows are not all in
 * stays held for the expiry sweep. A refusal (the ceiling, the embedding
 * plane's share, an unverifiable spend state) pauses the job with `budget`.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	AdmissionRefusedError,
	costMicrousd,
	inputTokenBound,
} from '../lib/llm/admissionPort';
import { MAX_LLM_ATTEMPTS } from '../lib/llm/retryPolicy';
import { reserveHold } from './admissionPorts';

/** How long a batch may run before its hold is presumed dead. */
const BATCH_DEADLINE_MS = 10 * 60 * 1000;

/** One batch, as the embed lane describes it before any call. */
export interface EmbeddingBatchRequest {
	readonly rootRequestId: string;
	readonly task: 'embedding.index';
	readonly jobKind: string;
	readonly provider: string;
	readonly model: string;
	/** Texts the batch embeds, one call each. */
	readonly items: number;
	/** Their total length in characters. */
	readonly inputChars: number;
}

export type EmbeddingBatchAdmission =
	| {
			readonly isAdmitted: true;
			readonly reservationId?: string;
			readonly settle: (usage: {
				readonly dispatchedCalls: number;
				readonly inputTokens: number | undefined;
			}) => Promise<void>;
	  }
	| { readonly isAdmitted: false; readonly reason: string };

/**
 * UTF-8 bytes per UTF-16 code unit at most (a BMP character is up to three
 * bytes in one unit; an astral one is four bytes in two), so the batch's
 * characters bound its bytes, and bytes bound its tokens (`lib/llm/admissionPort.ts`).
 */
const MAX_BYTES_PER_CHAR = 3;

/**
 * The batch's worst case: every text sent up to the attempt allowance. Each
 * request is bounded by the whole batch's text (any one text is at most all of it).
 */
export function embeddingBatchHold(batch: EmbeddingBatchRequest): {
	microusd: number;
	maxRequests: number;
	maxRequestMicrousd: number;
} {
	const items = Math.max(1, Math.floor(batch.items));
	const bytes = Math.max(0, batch.inputChars) * MAX_BYTES_PER_CHAR;
	const price = (promptTokens: number) =>
		costMicrousd(
			batch.model,
			{ promptTokens, completionTokens: 0, totalTokens: promptTokens },
			'embedding'
		);
	// Every text once, each request with its own framing, every attempt.
	const onePass = bytes + items * inputTokenBound(0, 1);
	return {
		microusd: price(onePass * MAX_LLM_ATTEMPTS),
		maxRequests: items * MAX_LLM_ATTEMPTS,
		maxRequestMicrousd: price(inputTokenBound(bytes, 1)),
	};
}

/** Admit one paid batch, or refuse it with the reason the job shows. */
export async function admitEmbeddingBatch(
	ctx: ActionCtx,
	batch: EmbeddingBatchRequest
): Promise<EmbeddingBatchAdmission> {
	const hold = embeddingBatchHold(batch);
	let held: { reservationId: string } | null;
	try {
		held = await reserveHold(ctx, {
			task: batch.task,
			plane: 'embedding',
			budgetClass: 'standard',
			// A probe answers an admin waiting on the page; a job is background work.
			priority: batch.jobKind === 'probe' ? 'interactive' : 'background',
			root: { rootRequestId: batch.rootRequestId },
			microusd: hold.microusd,
			maxRequests: hold.maxRequests,
			requestBound: { microusd: hold.maxRequestMicrousd },
			modelId: batch.model,
			endpoint: `embedding:${batch.provider}`,
			deadlineAt: Date.now() + BATCH_DEADLINE_MS,
		});
	} catch (error) {
		if (error instanceof AdmissionRefusedError) {
			return { isAdmitted: false, reason: error.data.message };
		}
		throw error;
	}
	if (!held) return { isAdmitted: true, settle: async () => {} };
	const { reservationId } = held;
	let isSettled = false;
	return {
		isAdmitted: true,
		reservationId,
		settle: async ({ dispatchedCalls }) => {
			if (isSettled) return;
			isSettled = true;
			if (dispatchedCalls === 0) {
				await ctx.runMutation(internal.aiRouting.admission.release, { reservationId });
				return;
			}
			await ctx.runMutation(internal.aiRouting.admission.settle, {
				reservationId,
				expectedRequests: dispatchedCalls,
			});
		},
	};
}
