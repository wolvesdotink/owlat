/**
 * The deployment-ledger side of plugin LLM settlement (ADR-0073): the metered
 * provider requests a settlement carries, and the rows it writes for them.
 * Split from `./llmAccounting.ts` for size; called only from its settlement
 * mutations, in the same transaction as the plugin budget.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	insertLlmUsage,
	meteredRequestValidator,
	type MeteredRequest,
} from '../analytics/llmUsage';
import type { TokenUsage } from '../agent/steps/types';
import { MAX_LLM_ATTEMPTS } from '../lib/llm/retryPolicy';

/** The provider requests of one plugin call, as the dispatch metered them (ADR-0073). */
export const meteredCallArgs = {
	requestId: v.optional(v.string()),
	/** The host's root request and calling call, so the rows join the message's other spend. */
	rootRequestId: v.optional(v.string()),
	parentCallId: v.optional(v.string()),
	requests: v.optional(v.array(meteredRequestValidator)),
};

/**
 * One ledger row per provider request of a plugin call (ADR-0073), written in
 * the settlement mutation so the plugin budget and the deployment ledger move
 * together. A row is priced at the model the provider reported, else the
 * reserved one; a request with no valid reported usage writes a zero-cost row,
 * and every row of an unaccounted settlement is marked `isEstimated`. At most
 * {@link MAX_LLM_ATTEMPTS} requests: a plugin call is one-shot text.
 */
export async function insertPluginRequestRows(
	ctx: MutationCtx,
	reservation: Doc<'pluginLlmReservations'>,
	args: {
		requestId?: string;
		rootRequestId?: string;
		parentCallId?: string;
		requests?: MeteredRequest[];
		modelUsed?: string;
		isEstimate?: boolean;
	},
	validTokenUsage: (usage: TokenUsage | undefined) => usage is TokenUsage
): Promise<void> {
	const requests = args.requests ?? [];
	if (requests.length > MAX_LLM_ATTEMPTS) throw new Error('Plugin LLM settlement denied');
	for (const request of requests) {
		const usage = validTokenUsage(request.usage) ? request.usage : undefined;
		await insertLlmUsage(
			ctx,
			`plugin:${reservation.pluginId}`,
			usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			args.modelUsed ?? reservation.modelId,
			{ organizationId: reservation.organizationId, pluginId: reservation.pluginId },
			{
				...(args.requestId ? { requestId: args.requestId } : {}),
				...(args.rootRequestId ? { rootRequestId: args.rootRequestId } : {}),
				...(args.parentCallId ? { parentCallId: args.parentCallId } : {}),
				attempt: request.attempt,
				latencyMs: request.latencyMs,
				endpoint: reservation.endpointProvenance,
				isEstimated: usage === undefined || args.isEstimate === true,
				...(request.cacheReadTokens === undefined
					? {}
					: { cacheReadTokens: request.cacheReadTokens }),
				...(request.cacheWriteTokens === undefined
					? {}
					: { cacheWriteTokens: request.cacheWriteTokens }),
				...(request.reasoningTokens === undefined
					? {}
					: { reasoningTokens: request.reasoningTokens }),
			}
		);
	}
}
