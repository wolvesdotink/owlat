'use node';

import { randomUUID } from 'node:crypto';
import {
	parsePluginId,
	type PluginLlmGenerateRequest,
	type PluginLlmGenerateResult,
	type PluginLlmService,
} from '@owlat/plugin-kit';
import type { FunctionArgs } from 'convex/server';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { MAX_LLM_ATTEMPTS, runLlmTextWithAttemptMetadata } from '../lib/llm/dispatch';
import { estimateAdmissionCostMicrousd } from '../lib/llm/pricing';
import { resolveLanguageModelWithProvenance } from '../lib/llmProvider';
import { LlmCallMeter, type LlmRootContext } from '../lib/llm/requestMeter';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import type { MeteredRequest } from '../analytics/llmUsage';
import { PLUGIN_LLM_MAX_OUTPUT_TOKENS, validatePluginLlmRequest } from './llmRequest';

type PluginLlmErrorCode =
	| 'access_denied'
	| 'accounting_unavailable'
	| 'invalid_input'
	| 'provider_failure';

export class PluginLlmError extends Error {
	readonly code: PluginLlmErrorCode;

	constructor(code: PluginLlmErrorCode) {
		super(errorMessage(code));
		this.name = 'PluginLlmError';
		this.code = code;
	}
}

interface PluginLlmActorPolicy {
	readonly kind: 'authenticated_actor' | 'system_actor';
	authorize(ctx: ActionCtx, pluginId: string): Promise<unknown>;
	recordDenied(ctx: ActionCtx, pluginId: string): Promise<unknown>;
}

const AUTHENTICATED_ACTOR_POLICY: PluginLlmActorPolicy = Object.freeze({
	kind: 'authenticated_actor',
	authorize: (ctx: ActionCtx, pluginId: string) =>
		ctx.runQuery(internal.plugins.llmAccounting.authorize, { pluginId }),
	recordDenied: (ctx: ActionCtx, pluginId: string) =>
		ctx.runMutation(internal.plugins.llmAccounting.recordDenied, { pluginId }),
});
const SYSTEM_ACTOR_POLICY: PluginLlmActorPolicy = Object.freeze({
	kind: 'system_actor',
	authorize: (ctx: ActionCtx, pluginId: string) =>
		ctx.runQuery(internal.plugins.llmAccounting.authorizeSystem, { pluginId }),
	recordDenied: (ctx: ActionCtx, pluginId: string) =>
		ctx.runMutation(internal.plugins.llmAccounting.recordDeniedSystem, { pluginId }),
});

/**
 * Bind the public plugin service to one validated plugin id. Organization,
 * actor, grants, enablement, and budget are derived and rechecked inside the
 * reservation transaction immediately before every provider dispatch.
 */
export function bindAuthenticatedBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown
): PluginLlmService {
	return bindBundledPluginLlm(ctx, pluginIdInput, AUTHENTICATED_ACTOR_POLICY);
}

/** Background-host variant; authorization and settlement remain system-attributed. */
export function bindSystemBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown,
	executionSignal?: AbortSignal,
	/** The host's root request (a draft's message): the plugin's rows group under it. */
	root?: LlmRootContext
): PluginLlmService {
	return bindBundledPluginLlm(ctx, pluginIdInput, SYSTEM_ACTOR_POLICY, executionSignal, root);
}

function bindBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown,
	actorPolicy: PluginLlmActorPolicy,
	executionSignal?: AbortSignal,
	root?: LlmRootContext
): PluginLlmService {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		throw new PluginLlmError('access_denied');
	}

	return Object.freeze({
		async generate(requestInput: PluginLlmGenerateRequest): Promise<PluginLlmGenerateResult> {
			assertExecutionActive(executionSignal);
			let request;
			try {
				request = validatePluginLlmRequest(requestInput);
			} catch {
				assertExecutionActive(executionSignal);
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('invalid_input');
			}

			try {
				await actorPolicy.authorize(ctx, pluginId);
				assertExecutionActive(executionSignal);
			} catch {
				assertExecutionActive(executionSignal);
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}

			let resolvedModel: Awaited<ReturnType<typeof resolveLanguageModelWithProvenance>>;
			let perAttemptMicrousd: number;
			try {
				resolvedModel = await resolveLanguageModelWithProvenance(ctx, 'plugin.invoke', {
					tier: request.tier,
				});
				perAttemptMicrousd =
					estimateAdmissionCostMicrousd(resolvedModel.endpointProvenance, resolvedModel.modelId, {
						promptTokens: request.inputTokensUpperBound,
						completionTokens: PLUGIN_LLM_MAX_OUTPUT_TOKENS,
						totalTokens: request.inputTokensUpperBound + PLUGIN_LLM_MAX_OUTPUT_TOKENS,
					}) ?? 0;
				if (perAttemptMicrousd < 1) throw new Error('Unpriced model');
				assertExecutionActive(executionSignal);
			} catch {
				assertExecutionActive(executionSignal);
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}

			const reservationId = randomUUID();
			const reservedMicrousd = perAttemptMicrousd * MAX_LLM_ATTEMPTS;
			if (!Number.isSafeInteger(reservedMicrousd)) {
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}
			try {
				assertExecutionActive(executionSignal);
				await ctx.runMutation(internal.plugins.llmAccounting.reserve, {
					pluginId,
					reservationId,
					reservedMicrousd,
					tier: request.tier,
					modelId: resolvedModel.modelId,
					endpointProvenance: resolvedModel.endpointProvenance,
					actorMode: actorPolicy.kind,
					...(root ? { rootRequestId: root.rootRequestId } : {}),
				});
			} catch {
				assertExecutionActive(executionSignal);
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}
			if (executionSignal?.aborted) {
				await settleFailure(ctx, reservationId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}

			// Every provider request lands in the deployment ledger at settlement.
			// Settlement is idempotent per reservation, retried, then recovered by
			// a scheduled job that carries the requests (`settleDurably`), so
			// reading the pending requests needs no acknowledgement.
			const meter = new LlmCallMeter({
				task: 'plugin.invoke',
				deadlineAt: anchorActionDeadline(ctx),
				...(root ? { root } : {}),
			});
			const metered = () => ({
				requestId: meter.requestId,
				...(root ? { rootRequestId: root.rootRequestId } : {}),
				...(root?.parentCallId ? { parentCallId: root.parentCallId } : {}),
				requests: meter.pendingWrites().map(({ outcome: _outcome, ...request }) => request),
			});
			let dispatched;
			try {
				assertExecutionActive(executionSignal);
				dispatched = await runLlmTextWithAttemptMetadata({
					meter,
					model: resolvedModel.model,
					...request.dispatchInput,
					maxOutputTokens: PLUGIN_LLM_MAX_OUTPUT_TOKENS,
					...(executionSignal ? { abortSignal: executionSignal } : {}),
				});
				assertExecutionActive(executionSignal);
			} catch {
				const settled = await settleFailure(ctx, reservationId, actorPolicy, metered());
				if (!settled) throw new PluginLlmError('accounting_unavailable');
				assertExecutionActive(executionSignal);
				throw new PluginLlmError('provider_failure');
			}
			assertExecutionActive(executionSignal);
			const success = {
				reservationId,
				modelUsed: dispatched.providerModelUsed,
				tokenUsage: dispatched.result.tokenUsage,
				attempts: dispatched.attempts,
				...metered(),
			};
			const settled = await settleDurably(
				ctx,
				() =>
					ctx.runMutation(internal.plugins.llmAccounting.settleSuccess, {
						...success,
						actorMode: actorPolicy.kind,
					}),
				{ ...success, outcome: 'success' }
			);
			assertExecutionActive(executionSignal);
			// Neither written nor queued: the reservation stays pending and fully
			// charged (it already consumed headroom), and the caller is told.
			if (!settled) throw new PluginLlmError('accounting_unavailable');
			return Object.freeze({
				text: dispatched.result.text,
				modelUsed: dispatched.providerModelUsed,
				usage: dispatched.result.tokenUsage,
			});
		},
	});
}

function assertExecutionActive(executionSignal: AbortSignal | undefined): void {
	if (executionSignal?.aborted) throw new PluginLlmError('access_denied');
}

async function recordDenied(
	ctx: ActionCtx,
	pluginId: string,
	actorPolicy: PluginLlmActorPolicy
): Promise<void> {
	await actorPolicy.recordDenied(ctx, pluginId).catch(() => null);
}

async function settleFailure(
	ctx: ActionCtx,
	reservationId: string,
	actorPolicy: PluginLlmActorPolicy,
	metered: {
		requestId?: string;
		rootRequestId?: string;
		parentCallId?: string;
		requests?: MeteredRequest[];
	} = {}
): Promise<boolean> {
	// Pending reservations remain fully charged through their UTC day. Never
	// reopen budget headroom when terminal accounting is unavailable.
	return settleDurably(
		ctx,
		() =>
			ctx.runMutation(internal.plugins.llmAccounting.settleFailure, {
				reservationId,
				actorMode: actorPolicy.kind,
				...metered,
			}),
		{ reservationId, ...metered, outcome: 'failure' }
	);
}

/** Direct settlement tries before the settlement is handed to the scheduler. */
const SETTLEMENT_TRIES = 2;

/**
 * Settle a reservation without losing it to a transient failure (ADR-0073):
 * the settlement mutation (idempotent per reservation) is tried twice, then
 * `recoverSettlement` is scheduled with the same arguments, metered requests
 * included. True once the settlement is written or durably queued.
 */
async function settleDurably(
	ctx: ActionCtx,
	settle: () => Promise<unknown>,
	recovery: FunctionArgs<typeof internal.plugins.llmAccounting.recoverSettlement>
): Promise<boolean> {
	for (let tryNumber = 0; tryNumber < SETTLEMENT_TRIES; tryNumber++) {
		try {
			await settle();
			return true;
		} catch {
			// retried below, then recovered
		}
	}
	try {
		await ctx.scheduler.runAfter(0, internal.plugins.llmAccounting.recoverSettlement, recovery);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(code: PluginLlmErrorCode): string {
	switch (code) {
		case 'access_denied':
			return 'Plugin LLM access denied';
		case 'accounting_unavailable':
			return 'Plugin LLM accounting unavailable';
		case 'invalid_input':
			return 'Invalid plugin LLM request';
		case 'provider_failure':
			return 'Plugin LLM request failed';
	}
}
