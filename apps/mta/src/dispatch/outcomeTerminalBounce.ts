/**
 * The shared effect builders of the Dispatch reducer (`outcome.ts`).
 *
 * A sibling of `outcomeEvent.ts` and `outcomeClassifiedResponse.ts` rather than
 * more lines in `outcome.ts` (CONVENTIONS' ~500 LOC guideline). It holds the one
 * terminal-bounce effect list that both the 5xx hard bounce and the non-retryable
 * 4xx deferral emit, plus the two effect literals every reducer repeats.
 */

import type { MetricOutcome } from '../types.js';
import type { DispatchEffect } from './effects.js';
import type { DispatchOutcome } from './outcomeClassification.js';
import { classifiedResponseEffect } from './outcomeClassifiedResponse.js';
import { outcomeEventBase } from './outcomeEvent.js';
import type { AttemptCtx } from './types.js';

/** The two outcomes that end a message as a hard bounce. */
type TerminalBounceOutcome = Extract<DispatchOutcome, { kind: 'hard_bounce' | 'deferred' }>;

/**
 * THE TERMINAL-BOUNCE EFFECT LIST, in the order `applyEffects` runs it.
 *
 * Both callers get the same list: a 5xx hard bounce, and a 4xx the classifier
 * marked non-retryable. They differ only in `notifyMessage`, the prose the
 * `bounced` event carries for the operator. The order is load-bearing: the
 * effects and idempotency suites pin it, and `suppress_recipient` must stay last.
 *
 * TWO `notify_convex` events, and they are not interchangeable. `bounced` moves
 * the send to a terminal status; `smtp.classified` moves the ramp's block-clause
 * counter (see `outcomeClassifiedResponse.ts`). A block category such as
 * `content_rejected` makes this refusal count in the numerator.
 */
export function terminalBounceEffects(
	ctx: AttemptCtx,
	outcome: TerminalBounceOutcome,
	notifyMessage: string
): DispatchEffect[] {
	const { job, ip, domain } = ctx;
	const { throttleKey, providerKey } = ctx.destination;
	return [
		circuitBreakerEffect(ctx, 'bounced'),
		{
			kind: 'smtp_response',
			domain,
			smtpCode: outcome.smtpCode,
			enhancedCode: outcome.enhancedCode,
		},
		{ kind: 'domain_throttle_reject', ip, throttleKey },
		{ kind: 'warming_record', ip, result: 'bounce', providerKey, utcDate: ctx.utcDate },
		metricsEffect(ctx, 'bounced'),
		{
			kind: 'log_delivery_event',
			event: {
				...outcomeEventBase(ctx),
				status: 'bounced',
				bounceType: 'hard',
				smtpCode: outcome.smtpCode,
				smtpResponse: outcome.error,
				category: outcome.classification.category,
				annotation: outcome.classification.annotation,
			},
		},
		{
			kind: 'notify_convex',
			event: {
				event: 'bounced',
				messageId: job.messageId,
				organizationId: job.organizationId,
				bounceType: 'hard',
				message: notifyMessage,
				timestamp: Date.now(),
			},
		},
		classifiedResponseEffect(outcome, ctx),
		{ kind: 'suppress_recipient', address: job.to, reason: 'hard_bounce' },
	];
}

/**
 * The per-ISP metrics sample. Its pool is `job.ipPool`, the REQUESTED pool, and
 * not the resolved `ctx.pool` the delivery log carries (a reducer invariant the
 * shared-invariants test pins).
 */
export function metricsEffect(ctx: AttemptCtx, outcome: MetricOutcome): DispatchEffect {
	return {
		kind: 'metrics_record',
		domain: ctx.domain,
		ip: ctx.ip,
		pool: ctx.job.ipPool,
		outcome,
		durationMs: ctx.durationMs,
		providerKey: ctx.destination.providerKey,
	};
}

/**
 * The circuit-breaker verdict for this attempt, carrying the probe receipt when
 * the routing lease made this send a breaker probe.
 */
export function circuitBreakerEffect(
	ctx: AttemptCtx,
	outcome: 'delivered' | 'bounced'
): DispatchEffect {
	return {
		kind: 'circuit_breaker_outcome',
		orgId: ctx.job.organizationId,
		outcome,
		providerKey: ctx.destination.providerKey,
		...probeReceipt(ctx.job),
	};
}

function probeReceipt(job: AttemptCtx['job']): {
	probeReceipt?: {
		messageId: string;
		globalGeneration?: number;
		providerGeneration?: number;
	};
} {
	const lease = job.routingLease;
	if (!lease?.probe && !lease?.globalProbe) return {};
	return {
		probeReceipt: {
			messageId: job.messageId,
			...(lease.globalProbe && lease.globalBreakerGeneration !== undefined
				? { globalGeneration: lease.globalBreakerGeneration }
				: {}),
			...(lease.probe && lease.providerBreakerGeneration !== undefined
				? { providerGeneration: lease.providerBreakerGeneration }
				: {}),
		},
	};
}
