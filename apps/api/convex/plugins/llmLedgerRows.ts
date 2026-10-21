/**
 * The deployment-ledger side of plugin LLM settlement: the metered
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
import { taskPolicy } from '../lib/llm/taskPolicy';
import { reserveInMutation } from '../aiRouting/admission';
import { reconcileLateRow, settleReservation } from '../aiRouting/settlement';

/** The provider requests of one plugin call, as the dispatch metered them. */
export const meteredCallArgs = {
	requestId: v.optional(v.string()),
	/** The host's root request and calling call, so the rows join the message's other spend. */
	rootRequestId: v.optional(v.string()),
	parentCallId: v.optional(v.string()),
	requests: v.optional(v.array(meteredRequestValidator)),
};

/**
 * One ledger row per provider request of a plugin call, written in
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
		const inserted = await insertLlmUsage(
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
				// The deployment hold taken with the plugin's reservation (same id).
				reservationId: reservation.reservationId,
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
		// The deployment hold may have expired before the plugin settled.
		await reconcileLateRow(ctx, reservation.reservationId, inserted);
	}
}

/** How long a plugin call's deployment hold may stay open before the sweep settles it. */
const PLUGIN_HOLD_TTL_MS = 30 * 60 * 1000;

/**
 * The deployment-wide spend hold of a plugin call, taken
 * in the plugin's reservation mutation under the same id, so a plugin call is
 * admitted against the deployment ceiling as well as its manifest budget.
 * False: refused (the ceiling, or a spend state that cannot be verified).
 */
export async function reserveDeploymentHold(
	ctx: MutationCtx,
	args: {
		reservationId: string;
		reservedMicrousd: number;
		modelId: string;
		endpointProvenance: string;
		rootRequestId?: string;
	}
): Promise<boolean> {
	const policy = taskPolicy('plugin.invoke');
	const result = await reserveInMutation(ctx, {
		reservationId: args.reservationId,
		rootRequestId: args.rootRequestId ?? `plugin:${args.reservationId}`,
		plane: 'language',
		task: 'plugin.invoke',
		budgetClass: policy.budgetClass,
		priority: policy.priority,
		heldMicrousd: args.reservedMicrousd,
		maxRequests: MAX_LLM_ATTEMPTS,
		// The plugin host prices each attempt at the same bound (`plugins/llm.ts`).
		requestBound: { microusd: Math.ceil(args.reservedMicrousd / MAX_LLM_ATTEMPTS) },
		modelId: args.modelId,
		endpoint: args.endpointProvenance,
		expiresAt: Date.now() + PLUGIN_HOLD_TTL_MS,
	});
	return result.isAdmitted;
}

/**
 * Settle the deployment hold once the call's rows are written. A settlement
 * that carried no request list (a previous release's caller) cannot say what
 * ran, so it is charged like a dead hold: the whole hold, less its rows.
 */
export async function settleDeploymentHold(
	ctx: MutationCtx,
	reservationId: string,
	requests: readonly unknown[] | undefined
): Promise<void> {
	await settleReservation(
		ctx,
		reservationId,
		requests === undefined
			? { mode: 'expired' }
			: { mode: 'call_end', expectedRequests: requests.length }
	);
}
