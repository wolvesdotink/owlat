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

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { providerFor } from './index';
import {
	isRetryableErrorCode,
	type DispatchResult,
	type EmailSendParams,
	type ExtrasFor,
	type SendProviderKind,
} from './types';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendProviderDispatch<K extends SendProviderKind>(
	ctx: ActionCtx,
	kind: K,
	params: EmailSendParams,
	extras?: ExtrasFor<K>,
): Promise<DispatchResult> {
	const module = providerFor(kind);
	const startTime = Date.now();
	let attempts = 0;

	for (let attempt = 0; attempt <= module.retryDelays.length; attempt++) {
		attempts++;
		const result = await module.sendEmail(params, extras);

		if (result.success) {
			const latencyMs = Date.now() - startTime;
			await ctx.scheduler.runAfter(
				0,
				internal.lib.sendProviders.health.recordSendResult,
				{ providerType: kind, success: true, latencyMs },
			);
			return { result, providerType: kind, latencyMs, attempts };
		}

		const isLastAttempt = attempt === module.retryDelays.length;
		const retryable = isRetryableErrorCode(result.errorCode);

		if (!retryable || isLastAttempt) {
			const latencyMs = Date.now() - startTime;
			await ctx.scheduler.runAfter(
				0,
				internal.lib.sendProviders.health.recordSendResult,
				{ providerType: kind, success: false, latencyMs },
			);
			return { result, providerType: kind, latencyMs, attempts };
		}

		const delayMs = module.retryDelays[attempt]!;
		await delay(delayMs);
	}

	// Unreachable — the loop returns at every iteration.
	throw new Error(
		'sendProviderDispatch: invariant violated — loop exhausted without returning',
	);
}
