/**
 * Dispatch outcome — pure reducer for the post-send branch.
 *
 * Mirrors the **Send lifecycle (module)** shape from ADR-0006: typed outcome
 * + typed effect list + runner. The reducer has no side effects, no Redis
 * dependency, and no HTTP dependency — it consumes the SMTP send result and
 * AttemptCtx and returns a list of `DispatchEffect`s plus an optional
 * defer instruction.
 *
 * See ADR-0007 and CONTEXT.md's MTA dispatch section.
 */

import { parseCampaignFromFeedbackId } from '../intelligence/campaignComplaintRate.js';
import type { AttemptCtx } from './types.js';
import type { DispatchEffect } from './effects.js';
import { outcomeEventBase } from './outcomeEvent.js';
import type { DispatchOutcome } from './outcomeClassification.js';
import { primarySendingDomain } from '../intelligence/gmailBulkSender.js';
import { applyDeliveryDomainPolicy } from './outcomeDeliveryDomain.js';

export { classifyResult } from './outcomeClassification.js';
export type { DispatchOutcome } from './outcomeClassification.js';

/**
 * The reducer's return type. `effects` runs through `applyEffects`;
 * `defer` (when present) tells the GroupMQ adapter how to re-enqueue.
 */
export interface OutcomeReduction {
	effects: DispatchEffect[];
	defer: { delayMs: number; reason: string } | undefined;
}

/**
 * Pure reducer — given an outcome and the attempt's ctx, returns the
 * effects to apply and the optional defer instruction.
 *
 * Tests assert against the returned data structure — no mocking of Redis,
 * metrics, logger, or fetch is required to verify the reducer's correctness.
 */
export function reduce(outcome: DispatchOutcome, ctx: AttemptCtx): OutcomeReduction {
	let reduction: OutcomeReduction;
	switch (outcome.kind) {
		case 'delivered':
			reduction = reduceDelivered(outcome, ctx);
			break;
		case 'hard_bounce':
			reduction = reduceHardBounce(outcome, ctx);
			break;
		case 'deferred':
			reduction = reduceDeferred(outcome, ctx);
			break;
		case 'soft_bounce':
			reduction = reduceSoftBounce(outcome, ctx);
			break;
		case 'ambiguous':
			reduction = reduceAmbiguous(outcome, ctx);
			break;
	}
	return applyDeliveryDomainPolicy(reduction, ctx);
}

function reduceDelivered(
	outcome: Extract<DispatchOutcome, { kind: 'delivered' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	const { job, ip, domain, durationMs } = ctx;
	const { throttleKey, providerKey } = ctx.destination;
	const sendingPrimaryDomain = primarySendingDomain(job.dkimDomain);
	// Per-campaign complaint rate needs a denominator: bump the campaign's
	// delivered counter when the job carries a campaign-stream `Feedback-ID`.
	const campaignId = parseCampaignFromFeedbackId(feedbackIdHeader(job.headers));
	return {
		effects: [
			{ kind: 'domain_throttle_success', ip, throttleKey, providerKey },
			{
				kind: 'circuit_breaker_outcome',
				orgId: job.organizationId,
				outcome: 'delivered',
				providerKey,
				...probeReceipt(job),
			},
			...(campaignId
				? [{ kind: 'campaign_delivery_record', campaignId } as const satisfies DispatchEffect]
				: []),
			{
				kind: 'smtp_response',
				domain,
				smtpCode: outcome.smtpCode,
				enhancedCode: outcome.enhancedCode,
			},
			{
				kind: 'warming_record',
				ip,
				result: 'send',
				reservation: job.routingLease?.warmingReservation,
			},
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'delivered',
				durationMs,
				providerKey,
			},
			{ kind: 'domain_failure_clear', domain },
			{
				kind: 'log_delivery_event',
				event: {
					...outcomeEventBase(ctx),
					status: 'delivered',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.smtpResponse,
				},
			},
			{
				kind: 'notify_convex',
				event: {
					event: 'sent',
					messageId: job.messageId,
					organizationId: job.organizationId,
					recipient: job.to,
					destinationProvider: providerKey,
					...(sendingPrimaryDomain ? { primarySendingDomain: sendingPrimaryDomain } : {}),
					remoteMessageId: outcome.remoteMessageId,
					timestamp: Date.now(),
				},
			},
		],
		defer: undefined,
	};
}

function reduceHardBounce(
	outcome: Extract<DispatchOutcome, { kind: 'hard_bounce' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	const { job, ip, domain, durationMs } = ctx;
	const { throttleKey, providerKey } = ctx.destination;
	return {
		effects: [
			{
				kind: 'circuit_breaker_outcome',
				orgId: job.organizationId,
				outcome: 'bounced',
				providerKey,
				...probeReceipt(job),
			},
			{
				kind: 'smtp_response',
				domain,
				smtpCode: outcome.smtpCode,
				enhancedCode: outcome.enhancedCode,
			},
			{ kind: 'domain_throttle_reject', ip, throttleKey },
			{ kind: 'warming_record', ip, result: 'bounce' },
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'bounced',
				durationMs,
				providerKey,
			},
			{
				kind: 'log_delivery_event',
				event: {
					...outcomeEventBase(ctx),
					status: 'bounced',
					bounceType: 'hard',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.error,
				},
			},
			{
				kind: 'notify_convex',
				event: {
					event: 'bounced',
					messageId: job.messageId,
					organizationId: job.organizationId,
					bounceType: 'hard',
					message: outcome.error,
					timestamp: Date.now(),
				},
			},
			{ kind: 'suppress_recipient', address: job.to, reason: 'hard_bounce' },
		],
		defer: undefined,
	};
}

function reduceDeferred(
	outcome: Extract<DispatchOutcome, { kind: 'deferred' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	// The SMTP classifier (smtpClassifier.ts) distinguishes transient 4xx
	// deferrals (greylisting, rate limiting, mailbox full) from 4xx responses
	// that are permanent for this message (policy/content rejection — RFC 6647,
	// RFC 5321 §4.2.1). Re-deferring a non-retryable response just loops the
	// job back into the queue until it exhausts attempts and lands in the
	// dead-letter — never delivered, never suppressed. When the classifier says
	// `retryable: false`, drop the message terminally (no defer) and treat it
	// as a hard bounce so the recipient/domain state is updated correctly.
	if (!outcome.classification.retryable) {
		return reduceNonRetryableDeferral(outcome, ctx);
	}
	const { job, ip, domain, durationMs } = ctx;
	const { throttleKey, providerKey } = ctx.destination;
	return {
		effects: [
			{ kind: 'domain_throttle_defer', ip, throttleKey, providerKey },
			{
				kind: 'smtp_response',
				domain,
				smtpCode: outcome.smtpCode,
				enhancedCode: outcome.enhancedCode,
			},
			{ kind: 'warming_record', ip, result: 'deferral' },
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'deferred',
				durationMs,
				providerKey,
			},
			{
				kind: 'log_delivery_event',
				event: {
					...outcomeEventBase(ctx),
					status: 'deferred',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.error,
					category: outcome.classification.category,
					annotation: outcome.classification.annotation,
				},
			},
		],
		defer: {
			delayMs: outcome.classification.suggestedDelayMs,
			reason: `SMTP deferral (${outcome.classification.category}): ${outcome.error}`,
		},
	};
}

/**
 * Terminal handling for a 4xx that the classifier marked non-retryable
 * (`policy_rejected` / `content_rejected`, or an unrecognised 5xx that surfaced
 * via the deferred path). Mirrors the hard-bounce reducer: no defer, suppress
 * the recipient, and report the failure as a hard bounce so the message stops
 * cycling toward the dead-letter queue (RFC 5321 §4.2.1 — a 4xx is "transient"
 * by code class, but the classifier knows this particular response will never
 * succeed for this message).
 */
function reduceNonRetryableDeferral(
	outcome: Extract<DispatchOutcome, { kind: 'deferred' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	const { job, ip, domain, durationMs } = ctx;
	const { throttleKey, providerKey } = ctx.destination;
	return {
		effects: [
			{
				kind: 'circuit_breaker_outcome',
				orgId: job.organizationId,
				outcome: 'bounced',
				providerKey,
				...probeReceipt(job),
			},
			{
				kind: 'smtp_response',
				domain,
				smtpCode: outcome.smtpCode,
				enhancedCode: outcome.enhancedCode,
			},
			{ kind: 'domain_throttle_reject', ip, throttleKey },
			{ kind: 'warming_record', ip, result: 'bounce' },
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'bounced',
				durationMs,
				providerKey,
			},
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
					message: `Non-retryable SMTP deferral (${outcome.classification.category}): ${outcome.error}`,
					timestamp: Date.now(),
				},
			},
			{ kind: 'suppress_recipient', address: job.to, reason: 'hard_bounce' },
		],
		defer: undefined,
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

function reduceSoftBounce(
	outcome: Extract<DispatchOutcome, { kind: 'soft_bounce' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	const { job, ip, domain, durationMs } = ctx;
	const { providerKey } = ctx.destination;
	return {
		effects: [
			{
				kind: 'circuit_breaker_outcome',
				orgId: job.organizationId,
				outcome: 'bounced',
				providerKey,
				...probeReceipt(job),
			},
			{ kind: 'warming_record', ip, result: 'bounce' },
			{ kind: 'domain_failure_record', domain },
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'error',
				durationMs,
				providerKey,
			},
			{
				kind: 'log_delivery_event',
				event: {
					...outcomeEventBase(ctx),
					status: 'failed',
					smtpResponse: outcome.error,
				},
			},
			{
				kind: 'notify_convex',
				event: {
					event: 'bounced',
					messageId: job.messageId,
					organizationId: job.organizationId,
					bounceType: 'soft',
					message: outcome.error,
					timestamp: Date.now(),
				},
			},
		],
		defer: {
			delayMs: 60_000,
			reason: `Soft bounce: ${outcome.error}`,
		},
	};
}

/**
 * Terminal handling for the post-DATA ambiguous drop (AMBIGUOUS_TIMEOUT, W8).
 *
 * The body — and possibly the terminating dot — was already on the wire when the
 * connection dropped with no server reply, so the receiver MAY have accepted the
 * message. We therefore MUST NOT:
 *  - requeue / try the next MX (`defer: undefined`) — a retry risks a double
 *    delivery (this is the W8 property established in round 1);
 *  - suppress the recipient — the address is very likely valid and delivery may
 *    have succeeded (unlike `reduceHardBounce`);
 *  - fabricate a 5xx `smtp_response` — there was no reply, so recording a
 *    synthetic 550 would poison per-domain SMTP-response intelligence (W7/W8);
 *  - penalise reputation — no `circuit_breaker_outcome: 'bounced'`, no
 *    `domain_throttle_reject`, no `warming_record: 'bounce'`, no bounced Convex
 *    notification. A transient TCP reset is not evidence of a bad recipient.
 *
 * We record a neutral, observable terminal event (delivery log + an `error`
 * metric) AND notify Convex with a terminal, non-bounce `failed` status so the
 * message row leaves "sending" and reaches a terminal state (there is no
 * per-message reconciliation cron to sweep it otherwise). The `failed` event is
 * distinct from `bounced`: Convex maps it to the terminal `failed` send status
 * WITHOUT recipient suppression, so a transient TCP reset after the terminating
 * dot never lands a likely-valid address on the blocklist.
 */
function reduceAmbiguous(
	outcome: Extract<DispatchOutcome, { kind: 'ambiguous' }>,
	ctx: AttemptCtx
): OutcomeReduction {
	const { job, ip, domain, durationMs } = ctx;
	const { providerKey } = ctx.destination;
	return {
		effects: [
			{
				kind: 'metrics_record',
				domain,
				ip,
				pool: job.ipPool,
				outcome: 'error',
				durationMs,
				providerKey,
			},
			{
				kind: 'log_delivery_event',
				event: {
					...outcomeEventBase(ctx),
					status: 'failed',
					smtpResponse: outcome.error,
					reason: 'ambiguous_post_data',
				},
			},
			// Terminal, non-bounce notification: moves the message row out of
			// "sending" to the terminal `failed` status. Deliberately NOT `bounced`
			// (no suppress_recipient, no reputation penalty) — the receiver may have
			// accepted the message and the address is very likely valid.
			{
				kind: 'notify_convex',
				event: {
					event: 'failed',
					messageId: job.messageId,
					organizationId: job.organizationId,
					message: `Ambiguous post-DATA drop: ${outcome.error}`,
					severity: 'warning',
					timestamp: Date.now(),
				},
			},
		],
		defer: undefined,
	};
}

/**
 * Case-insensitive lookup of the `Feedback-ID` header value off the job's
 * optional headers. The composer emits it as `Feedback-ID`, but tolerate any
 * case so the campaign-delivery counter isn't silently lost on a casing drift.
 */
function feedbackIdHeader(headers: Record<string, string> | undefined): string | undefined {
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === 'feedback-id') return value;
	}
	return undefined;
}
