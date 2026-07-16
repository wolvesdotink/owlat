'use node';

/**
 * Send dispatch (helper).
 *
 * Per ADR-0020. Single entry point for send-side provider work. Six producers
 * route through this: the workpool worker, the campaign orchestrator's one-off
 * test send, the post-send resend in `emailsSending.ts`, the automation email
 * step, the transactional HTTP send, and any future internal sender.
 *
 * Responsibilities:
 *   1. Retry loop driven by `module.retryDelays` and `module.categorizeError`.
 *      Each attempt calls the module's single-attempt `sendEmail`.
 *   2. Health recording — writes to `providerHealth` via the
 *      **Send provider health (module)**'s `recordSendResult` mutation after
 *      every terminal outcome (success or exhausted retries). Closes the
 *      silent-drift bug where bypass callers (test sends, automation steps)
 *      previously skipped health recording.
 *   3. Error categorization at the boundary — the result carries the typed
 *      `EmailErrorCode`, not just the raw error string.
 *
 * See CONTEXT.md "Send dispatch (helper)".
 */

import {
	createPluginHost,
	type PluginHost,
	type PluginUntrustedTextPolicy,
} from '@owlat/plugin-host';
import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { isEnvPresent } from '../env';
import { getBundledPluginManifest } from '../../plugins/authorization';
import { sendProviderCatalogEntry } from './catalog';
import { providerFor } from './index';
import {
	EmailErrorCode,
	isRetryableErrorCode,
	type DispatchResult,
	type EmailSendParams,
	type ExtrasFor,
	type SendProviderKind,
} from './types';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The generic host requires a text policy, but send transports return only a
// typed message id or failure code. If that contract ever grows a text result,
// this deny-all policy prevents accidental prompt-boundary use.
const NON_TEXT_TRANSPORT_POLICY: PluginUntrustedTextPolicy = Object.freeze({
	maximumCodePoints: 1,
	scrubPromptInjection: () => '',
});

export async function sendProviderDispatch<K extends SendProviderKind>(
	ctx: ActionCtx,
	kind: K,
	params: EmailSendParams,
	extras?: ExtrasFor<K>
): Promise<DispatchResult> {
	const module = providerFor(kind);
	const catalogEntry = sendProviderCatalogEntry(kind);
	const pluginId = catalogEntry.pluginId;
	const pluginHost = pluginId ? createSendTransportHost(pluginId) : null;
	const startTime = Date.now();
	let attempts = 0;

	for (let attempt = 0; attempt <= module.retryDelays.length; attempt++) {
		if (pluginId) {
			const authorized = await ctx.runMutation(
				internal.plugins.sendTransportAuthorization.authorizeAttempt,
				{ pluginId, providerKind: kind }
			);
			if (!authorized) {
				return await terminalResult(ctx, kind, startTime, attempts, {
					success: false,
					errorCode: EmailErrorCode.AUTH_FAILED,
					errorMessage: 'Bundled send transport access denied',
				});
			}
		}
		attempts++;
		const sendEmail = module.sendEmail.bind(module) as (
			params: EmailSendParams,
			extras?: unknown
		) => Promise<DispatchResult['result']>;
		const result = await runAttempt(pluginHost, sendEmail, params, extras);

		if (result.success) {
			return await terminalResult(ctx, kind, startTime, attempts, result, pluginId);
		}

		const isLastAttempt = attempt === module.retryDelays.length;
		const retryable = isRetryableErrorCode(result.errorCode);

		if (!retryable || isLastAttempt) {
			return await terminalResult(ctx, kind, startTime, attempts, result, pluginId);
		}

		const delayMs = module.retryDelays[attempt]!;
		await delay(delayMs);
	}

	// Unreachable — the loop returns at every iteration.
	throw new Error('sendProviderDispatch: invariant violated — loop exhausted without returning');
}

function createSendTransportHost(
	pluginId: NonNullable<ReturnType<typeof sendProviderCatalogEntry>['pluginId']>
): PluginHost {
	return createPluginHost({
		manifest: getBundledPluginManifest(pluginId),
		capabilityGrants: [{ capability: PLUGIN_SEND_TRANSPORT_CAPABILITY, granted: true }],
		featureFlags: { isEnabled: () => true },
		environment: { isPresent: isEnvPresent },
		untrustedText: NON_TEXT_TRANSPORT_POLICY,
	});
}

async function runAttempt(
	host: PluginHost | null,
	sendEmail: (params: EmailSendParams, extras?: unknown) => Promise<DispatchResult['result']>,
	params: EmailSendParams,
	extras: unknown
): Promise<DispatchResult['result']> {
	try {
		return host
			? await host.run(PLUGIN_SEND_TRANSPORT_CAPABILITY, () => sendEmail(params, extras))
			: await sendEmail(params, extras);
	} catch {
		return {
			success: false,
			errorCode: EmailErrorCode.UNKNOWN,
			errorMessage: 'Bundled send transport failed',
		};
	}
}

async function terminalResult(
	ctx: ActionCtx,
	kind: SendProviderKind,
	startTime: number,
	attempts: number,
	result: DispatchResult['result'],
	pluginId?: ReturnType<typeof sendProviderCatalogEntry>['pluginId']
): Promise<DispatchResult> {
	const latencyMs = Date.now() - startTime;
	await ctx.scheduler.runAfter(0, internal.lib.sendProviders.health.recordSendResult, {
		providerType: kind,
		success: result.success,
		latencyMs,
	});
	if (pluginId) {
		await ctx.scheduler.runAfter(0, internal.plugins.sendTransportAuthorization.recordOutcome, {
			pluginId,
			providerKind: kind,
			attempts,
			success: result.success,
		});
	}
	return { result, providerType: kind, latencyMs, attempts };
}
