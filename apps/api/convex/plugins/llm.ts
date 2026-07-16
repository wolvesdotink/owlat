'use node';

import { randomUUID } from 'node:crypto';
import {
	parsePluginId,
	type PluginLlmGenerateRequest,
	type PluginLlmGenerateResult,
	type PluginLlmService,
} from '@owlat/plugin-kit';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { MAX_LLM_ATTEMPTS, runLlmTextWithAttemptMetadata } from '../lib/llm/dispatch';
import { estimateKnownCostMicrousd } from '../lib/llm/pricing';
import { resolveLanguageModelWithProvenance } from '../lib/llmProvider';
import { PLUGIN_LLM_MAX_OUTPUT_TOKENS, validatePluginLlmRequest } from './llmRequest';

export type PluginLlmErrorCode =
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

type PluginLlmActorPolicy =
	| Readonly<{ kind: 'authenticated_actor' }>
	| Readonly<{ kind: 'system_actor' }>;

const AUTHENTICATED_ACTOR_POLICY: PluginLlmActorPolicy = Object.freeze({
	kind: 'authenticated_actor',
});
const SYSTEM_ACTOR_POLICY: PluginLlmActorPolicy = Object.freeze({ kind: 'system_actor' });

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
	pluginIdInput: unknown
): PluginLlmService {
	return bindBundledPluginLlm(ctx, pluginIdInput, SYSTEM_ACTOR_POLICY);
}

function bindBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown,
	actorPolicy: PluginLlmActorPolicy
): PluginLlmService {
	let pluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		throw new PluginLlmError('access_denied');
	}

	return Object.freeze({
		async generate(requestInput: PluginLlmGenerateRequest): Promise<PluginLlmGenerateResult> {
			let request;
			try {
				request = validatePluginLlmRequest(requestInput);
			} catch {
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('invalid_input');
			}

			try {
				await authorizeActor(ctx, pluginId, actorPolicy);
			} catch {
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}

			let resolvedModel: Awaited<ReturnType<typeof resolveLanguageModelWithProvenance>>;
			let perAttemptMicrousd: number;
			try {
				resolvedModel = await resolveLanguageModelWithProvenance(
					ctx,
					request.tier === 'fast' ? 'summarize' : 'draft'
				);
				perAttemptMicrousd =
					estimateKnownCostMicrousd(resolvedModel.endpointProvenance, resolvedModel.modelId, {
						promptTokens: request.inputTokensUpperBound,
						completionTokens: PLUGIN_LLM_MAX_OUTPUT_TOKENS,
						totalTokens: request.inputTokensUpperBound + PLUGIN_LLM_MAX_OUTPUT_TOKENS,
					}) ?? 0;
				if (perAttemptMicrousd < 1) throw new Error('Unpriced model');
			} catch {
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
				await ctx.runMutation(internal.plugins.llmAccounting.reserve, {
					pluginId,
					reservationId,
					reservedMicrousd,
					tier: request.tier,
					modelId: resolvedModel.modelId,
					endpointProvenance: resolvedModel.endpointProvenance,
					...accountingActorArgs(actorPolicy),
				});
			} catch {
				await recordDenied(ctx, pluginId, actorPolicy);
				throw new PluginLlmError('access_denied');
			}

			let dispatched;
			try {
				dispatched = await runLlmTextWithAttemptMetadata({
					model: resolvedModel.model,
					...request.dispatchInput,
					maxOutputTokens: PLUGIN_LLM_MAX_OUTPUT_TOKENS,
				});
			} catch {
				const settled = await settleFailure(ctx, reservationId, actorPolicy);
				if (!settled) throw new PluginLlmError('accounting_unavailable');
				throw new PluginLlmError('provider_failure');
			}
			try {
				await ctx.runMutation(internal.plugins.llmAccounting.settleSuccess, {
					reservationId,
					modelUsed: dispatched.result.modelUsed,
					tokenUsage: dispatched.result.tokenUsage,
					attempts: dispatched.attempts,
					...accountingActorArgs(actorPolicy),
				});
			} catch {
				// The reservation mutation already consumed headroom. A failed
				// settlement leaves it pending and fully charged.
				throw new PluginLlmError('accounting_unavailable');
			}
			return Object.freeze({
				text: dispatched.result.text,
				modelUsed: dispatched.result.modelUsed,
				usage: dispatched.result.tokenUsage,
			});
		},
	});
}

async function authorizeActor(
	ctx: ActionCtx,
	pluginId: string,
	actorPolicy: PluginLlmActorPolicy
): Promise<void> {
	if (actorPolicy.kind === 'system_actor') {
		await ctx.runQuery(internal.plugins.llmAccounting.authorizeSystem, { pluginId });
		return;
	}
	await ctx.runQuery(internal.plugins.llmAccounting.authorize, { pluginId });
}

async function recordDenied(
	ctx: ActionCtx,
	pluginId: string,
	actorPolicy: PluginLlmActorPolicy
): Promise<void> {
	await ctx
		.runMutation(
			actorPolicy.kind === 'system_actor'
				? internal.plugins.llmAccounting.recordDeniedSystem
				: internal.plugins.llmAccounting.recordDenied,
			{ pluginId }
		)
		.catch(() => null);
}

async function settleFailure(
	ctx: ActionCtx,
	reservationId: string,
	actorPolicy: PluginLlmActorPolicy
): Promise<boolean> {
	try {
		await ctx.runMutation(internal.plugins.llmAccounting.settleFailure, {
			reservationId,
			...accountingActorArgs(actorPolicy),
		});
		return true;
	} catch {
		// Pending reservations remain fully charged through their UTC day. Never
		// reopen budget headroom when terminal accounting is unavailable.
		return false;
	}
}

function accountingActorArgs(
	actorPolicy: PluginLlmActorPolicy
): Readonly<Record<never, never>> | Readonly<{ system: true }> {
	return actorPolicy.kind === 'system_actor' ? { system: true } : {};
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
