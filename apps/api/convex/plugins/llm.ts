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

/**
 * Bind the public plugin service to one validated plugin id. Organization,
 * actor, grants, enablement, and budget are derived and rechecked inside the
 * reservation transaction immediately before every provider dispatch.
 */
export function bindAuthenticatedBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown
): PluginLlmService {
	return bindBundledPluginLlm(ctx, pluginIdInput, false);
}

/** Background-host variant; authorization and settlement remain system-attributed. */
export function bindSystemBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown
): PluginLlmService {
	return bindBundledPluginLlm(ctx, pluginIdInput, true);
}

function bindBundledPluginLlm(
	ctx: ActionCtx,
	pluginIdInput: unknown,
	system: boolean
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
				await recordDenied(ctx, pluginId, system);
				throw new PluginLlmError('invalid_input');
			}

			try {
				await ctx.runQuery(
					system
						? internal.plugins.llmAccounting.authorizeSystem
						: internal.plugins.llmAccounting.authorize,
					{ pluginId }
				);
			} catch {
				await recordDenied(ctx, pluginId, system);
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
				await recordDenied(ctx, pluginId, system);
				throw new PluginLlmError('access_denied');
			}

			const reservationId = randomUUID();
			const reservedMicrousd = perAttemptMicrousd * MAX_LLM_ATTEMPTS;
			if (!Number.isSafeInteger(reservedMicrousd)) {
				await recordDenied(ctx, pluginId, system);
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
					...(system ? { system: true } : {}),
				});
			} catch {
				await recordDenied(ctx, pluginId, system);
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
				const settled = await settleFailure(ctx, reservationId, system);
				if (!settled) throw new PluginLlmError('accounting_unavailable');
				throw new PluginLlmError('provider_failure');
			}
			try {
				await ctx.runMutation(internal.plugins.llmAccounting.settleSuccess, {
					reservationId,
					modelUsed: dispatched.result.modelUsed,
					tokenUsage: dispatched.result.tokenUsage,
					attempts: dispatched.attempts,
					...(system ? { system: true } : {}),
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

async function recordDenied(ctx: ActionCtx, pluginId: string, system: boolean): Promise<void> {
	await ctx
		.runMutation(
			system
				? internal.plugins.llmAccounting.recordDeniedSystem
				: internal.plugins.llmAccounting.recordDenied,
			{ pluginId }
		)
		.catch(() => null);
}

async function settleFailure(
	ctx: ActionCtx,
	reservationId: string,
	system: boolean
): Promise<boolean> {
	try {
		await ctx.runMutation(internal.plugins.llmAccounting.settleFailure, {
			reservationId,
			...(system ? { system: true } : {}),
		});
		return true;
	} catch {
		// Pending reservations remain fully charged through their UTC day. Never
		// reopen budget headroom when terminal accounting is unavailable.
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
