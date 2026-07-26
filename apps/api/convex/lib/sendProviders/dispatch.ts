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
import { PLUGIN_SEND_TRANSPORT_CAPABILITY, type PluginId } from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { isEnvPresent } from '../env';
import { getBundledPluginManifest } from '../../plugins/authorization';
import { providerFor } from './index';
import { resolveSendTransport, type SendTransportId, type SendTransportRecord } from './transports';
import {
	EmailErrorCode,
	isRetryableErrorCode,
	type DispatchResult,
	type EmailSendParams,
	type SendProviderExtras,
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

/** The send-side surface the dispatch loop needs, shared by core and hosted adapters. */
interface DispatchableSendModule {
	readonly retryDelays: readonly number[];
	sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: unknown
	): Promise<DispatchResult['result']>;
}

/**
 * Dispatch through ONE CONFIGURED TRANSPORT, named by its transport id.
 *
 * The id — not a bare kind — is the dispatch unit, so a deployment can hold two
 * transports of the same kind with different configuration and send through
 * them independently. Each adapter resolves its own credentials from the
 * resolved record; nothing secret passes through this helper.
 *
 * Resolution FAILS CLOSED: an unknown, malformed, undeclared or de-configured
 * id throws `SendTransportResolutionError` BEFORE any attempt, any health write
 * or any authorization call. It never falls through to another transport.
 *
 * `extras` is the kind-agnostic union — pin it at the call site with
 * `satisfies MtaExtras` / `satisfies ResendExtras`.
 */
export async function sendProviderDispatch(
	ctx: ActionCtx,
	transportId: SendTransportId,
	params: EmailSendParams,
	extras?: SendProviderExtras
): Promise<DispatchResult> {
	const transport = resolveSendTransport(transportId);
	const kind = transport.kind;
	// Core adapters and hosted (plugin) adapters share the send-side shape but
	// not the same interface. The loop below only ever needs that shared shape,
	// so it is narrowed once here instead of at every use.
	const module = providerFor(kind) as unknown as DispatchableSendModule;
	const pluginId = transport.pluginId;
	const pluginHost = pluginId ? createSendTransportHost(pluginId) : null;
	const startTime = Date.now();
	let attempts = 0;

	for (let attempt = 0; attempt <= module.retryDelays.length; attempt++) {
		if (pluginId) {
			const authorized = await ctx.runMutation(
				internal.plugins.sendTransportAuthorization.authorizeAttempt,
				{ pluginId, providerKind: kind, priorAttempts: attempts }
			);
			if (!authorized) {
				return await terminalResult(ctx, transport, startTime, attempts, {
					success: false,
					errorCode: EmailErrorCode.AUTH_FAILED,
					errorMessage: 'Bundled send transport access denied',
				});
			}
		}
		attempts++;
		const sendEmail = module.sendEmail.bind(module);
		const result = await runAttempt(pluginHost, sendEmail, transport, params, extras);

		if (result.success) {
			return await terminalResult(ctx, transport, startTime, attempts, result, pluginId);
		}

		const isLastAttempt = attempt === module.retryDelays.length;
		const retryable = isRetryableErrorCode(result.errorCode);

		if (!retryable || isLastAttempt) {
			return await terminalResult(ctx, transport, startTime, attempts, result, pluginId);
		}

		const delayMs = module.retryDelays[attempt]!;
		await delay(delayMs);
	}

	// Unreachable — the loop returns at every iteration.
	throw new Error('sendProviderDispatch: invariant violated — loop exhausted without returning');
}

function createSendTransportHost(pluginId: PluginId): PluginHost {
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
	sendEmail: (
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: unknown
	) => Promise<DispatchResult['result']>,
	transport: SendTransportRecord,
	params: EmailSendParams,
	extras: unknown
): Promise<DispatchResult['result']> {
	try {
		return host
			? await host.run(PLUGIN_SEND_TRANSPORT_CAPABILITY, () => sendEmail(transport, params, extras))
			: await sendEmail(transport, params, extras);
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
	transport: SendTransportRecord,
	startTime: number,
	attempts: number,
	result: DispatchResult['result'],
	pluginId?: PluginId
): Promise<DispatchResult> {
	const latencyMs = Date.now() - startTime;
	// Health stays keyed by provider KIND: `providerHealth` holds one row per
	// kind and the routing strategies compare against that field. Instances of a
	// kind therefore share a health row, exactly as before this refactor.
	await ctx.scheduler.runAfter(0, internal.lib.sendProviders.health.recordSendResult, {
		providerType: transport.kind,
		success: result.success,
		latencyMs,
	});
	if (pluginId) {
		await ctx.scheduler.runAfter(0, internal.plugins.sendTransportAuthorization.recordOutcome, {
			pluginId,
			providerKind: transport.kind,
			attempts,
			outcome: result.success ? 'completed' : 'failed',
		});
	}
	return { result, providerType: transport.kind, transportId: transport.id, latencyMs, attempts };
}
