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
 *      Each attempt calls the module's single-attempt `sendEmail`. A retryable
 *      failure waits `max(retryDelays[attempt], result.retryAfterMs)`, so a
 *      provider's Retry-After is honoured. The loop never waits longer in total
 *      than the sum of `retryDelays`: a Retry-After that does not fit in what is
 *      left of that budget returns the failure (with its `retryAfterMs`) at once.
 *   2. The ambiguous-timeout policy, decided here from the catalog rather than
 *      in each adapter. Adapters only report `AMBIGUOUS_TIMEOUT` ("the request
 *      may have been accepted"). It is retried only when the kind deduplicates
 *      on an idempotency key AND the extras carry one. Otherwise it is terminal,
 *      and a kind declaring `acceptanceSemantics: 'unknown-on-timeout'` gets
 *      `acceptanceUnknown: true`, which lets the governed boundary park the Send
 *      on provider feedback instead of failing it.
 *   3. Health recording — writes to `providerHealth` via the
 *      **Send provider health (module)**'s `recordSendResult` mutation after
 *      every terminal outcome (success or exhausted retries). Closes the
 *      silent-drift bug where bypass callers (test sends, automation steps)
 *      previously skipped health recording.
 *   4. Error categorization at the boundary — the result carries the typed
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
import { acceptanceSemanticsFor, deduplicatesOnIdempotencyKeyFor } from './catalog';
import {
	EmailErrorCode,
	isRetryableErrorCode,
	type DispatchResult,
	type EmailSendParams,
	type SendProviderExtras,
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
	// not the same interface. `providerFor`'s non-literal overload returns that
	// shared supertype, so this needs no cast — the module shape is still
	// checked here.
	const module: DispatchableSendModule = providerFor(kind);
	const pluginId = transport.pluginId;
	const pluginHost = pluginId ? createSendTransportHost(pluginId) : null;
	const startTime = Date.now();
	let attempts = 0;
	// The most the loop would ever wait on its own schedule. A Retry-After can
	// stretch one wait, but never the total.
	const waitBudgetMs = module.retryDelays.reduce((sum, delayMs) => sum + delayMs, 0);
	let waitedMs = 0;
	const mayRetryAmbiguousTimeout =
		deduplicatesOnIdempotencyKeyFor(kind) && carriesIdempotencyKey(extras);

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
		const ambiguous = result.errorCode === EmailErrorCode.AMBIGUOUS_TIMEOUT;
		const retryable = ambiguous ? mayRetryAmbiguousTimeout : isRetryableErrorCode(result.errorCode);
		const settled = ambiguous ? settleAmbiguousTimeout(kind, result) : result;

		if (!retryable || isLastAttempt) {
			return await terminalResult(ctx, transport, startTime, attempts, settled, pluginId);
		}

		const delayMs = Math.max(module.retryDelays[attempt]!, result.retryAfterMs ?? 0);
		if (waitedMs + delayMs > waitBudgetMs) {
			// The provider asked for a longer pause than this loop may still spend.
			// Hand the failure back now, `retryAfterMs` intact, rather than sleep
			// through the action's time or hammer a throttling provider early.
			return await terminalResult(ctx, transport, startTime, attempts, settled, pluginId);
		}
		await delay(delayMs);
		waitedMs += delayMs;
	}

	// Unreachable — the loop returns at every iteration.
	throw new Error('sendProviderDispatch: invariant violated — loop exhausted without returning');
}

/**
 * Does the kind-agnostic extras object carry a non-empty idempotency key?
 *
 * Read structurally: `ResendExtras`, `EmailitExtras` and the plugin tier all
 * name it `idempotencyKey`. A dedup-capable kind without a key (a system mail
 * whose caller supplied none, a test send) cannot dedup a retry, so its
 * ambiguous timeout is never retried blind.
 */
function carriesIdempotencyKey(extras: unknown): boolean {
	if (typeof extras !== 'object' || extras === null) return false;
	const key = (extras as { idempotencyKey?: unknown }).idempotencyKey;
	return typeof key === 'string' && key.length > 0;
}

/**
 * The terminal form of an ambiguous timeout. A kind that declares
 * `'unknown-on-timeout'` is marked `acceptanceUnknown`, so the governed
 * boundary parks the Send on provider feedback (or throws, for a kind with no
 * feedback channel) instead of recording a definite failure.
 */
function settleAmbiguousTimeout(
	kind: SendProviderKind,
	result: Extract<DispatchResult['result'], { success: false }>
): DispatchResult['result'] {
	return acceptanceSemanticsFor(kind) === 'unknown-on-timeout'
		? { ...result, acceptanceUnknown: true }
		: result;
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
