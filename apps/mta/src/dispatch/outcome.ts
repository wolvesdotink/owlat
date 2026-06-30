/**
 * Dispatch outcome — pure classification + reducer for the post-send branch.
 *
 * Mirrors the **Send lifecycle (module)** shape from ADR-0006: typed outcome
 * + typed effect list + runner. The reducer has no side effects, no Redis
 * dependency, and no HTTP dependency — it consumes the SMTP send result and
 * AttemptCtx and returns a list of `DispatchEffect`s plus an optional
 * defer instruction.
 *
 * See ADR-0007 and CONTEXT.md's MTA dispatch section.
 */

import type { EmailJobResult } from '../types.js';
import { classifySmtpResponse, type SmtpClassification } from '../intelligence/smtpClassifier.js';
import { parseCampaignFromFeedbackId } from '../intelligence/campaignComplaintRate.js';
import type { AttemptCtx } from './types.js';
import type { DispatchEffect } from './effects.js';

/**
 * The four possible outcomes of one Dispatch attempt's SMTP send.
 *
 * Fields are restricted to what's unique per outcome — shared facts (ip,
 * pool, domain, durationMs, job) live on the AttemptCtx the reducer
 * receives alongside.
 */
export type DispatchOutcome =
	| {
			kind: 'delivered';
			smtpCode: number;
			smtpResponse: string | undefined;
			remoteMessageId: string | undefined;
			enhancedCode: string | undefined;
	  }
	| {
			kind: 'hard_bounce';
			smtpCode: number;
			error: string;
			enhancedCode: string | undefined;
	  }
	| {
			kind: 'deferred';
			smtpCode: number;
			error: string;
			enhancedCode: string | undefined;
			classification: SmtpClassification;
	  }
	| {
			kind: 'soft_bounce';
			error: string;
	  };

/**
 * The reducer's return type. `effects` runs through `applyEffects`;
 * `defer` (when present) is converted to a `DeferError` throw by the
 * caller (`handler.ts`, the GroupMQ boundary).
 */
export interface OutcomeReduction {
	effects: DispatchEffect[];
	defer: { delayMs: number; reason: string } | undefined;
}

/**
 * Translate the SMTP sender's result into a typed DispatchOutcome.
 */
export function classifyResult(result: EmailJobResult): DispatchOutcome {
	if (result.success) {
		return {
			kind: 'delivered',
			smtpCode: result.smtpCode ?? 250,
			smtpResponse: result.smtpResponse,
			remoteMessageId: result.remoteMessageId,
			enhancedCode: result.enhancedCode,
		};
	}

	if (result.bounceType === 'hard') {
		return {
			kind: 'hard_bounce',
			smtpCode: result.smtpCode ?? 550,
			error: result.error ?? '',
			enhancedCode: result.enhancedCode,
		};
	}

	if (result.bounceType === 'deferred') {
		return {
			kind: 'deferred',
			smtpCode: result.smtpCode ?? 450,
			error: result.error ?? '',
			enhancedCode: result.enhancedCode,
			classification: classifySmtpResponse(
				result.smtpCode,
				result.error ?? '',
				result.enhancedCode,
			),
		};
	}

	return {
		kind: 'soft_bounce',
		error: result.error ?? '',
	};
}

/**
 * Pure reducer — given an outcome and the attempt's ctx, returns the
 * effects to apply and the optional defer instruction.
 *
 * Tests assert against the returned data structure — no mocking of Redis,
 * metrics, logger, or fetch is required to verify the reducer's correctness.
 */
export function reduce(outcome: DispatchOutcome, ctx: AttemptCtx): OutcomeReduction {
	switch (outcome.kind) {
		case 'delivered':
			return reduceDelivered(outcome, ctx);
		case 'hard_bounce':
			return reduceHardBounce(outcome, ctx);
		case 'deferred':
			return reduceDeferred(outcome, ctx);
		case 'soft_bounce':
			return reduceSoftBounce(outcome, ctx);
	}
}

function reduceDelivered(
	outcome: Extract<DispatchOutcome, { kind: 'delivered' }>,
	ctx: AttemptCtx,
): OutcomeReduction {
	const { job, ip, pool, domain, durationMs } = ctx;
	// Per-campaign complaint rate needs a denominator: bump the campaign's
	// delivered counter when the job carries a campaign-stream `Feedback-ID`.
	const campaignId = parseCampaignFromFeedbackId(feedbackIdHeader(job.headers));
	return {
		effects: [
			{ kind: 'domain_throttle_success', ip, domain },
			{ kind: 'circuit_breaker_outcome', orgId: job.organizationId, outcome: 'delivered' },
			...(campaignId
				? [{ kind: 'campaign_delivery_record', campaignId } as const satisfies DispatchEffect]
				: []),
			{ kind: 'smtp_response', domain, smtpCode: outcome.smtpCode, enhancedCode: outcome.enhancedCode },
			{ kind: 'warming_record', ip, result: 'send' },
			{ kind: 'metrics_record', domain, ip, pool: job.ipPool, outcome: 'delivered', durationMs },
			{ kind: 'domain_failure_clear', domain },
			{
				kind: 'log_delivery_event',
				event: {
					messageId: job.messageId,
					to: job.to,
					from: job.from,
					orgId: job.organizationId,
					status: 'delivered',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.smtpResponse,
					ip,
					pool,
					domain,
					durationMs,
				},
			},
			{
				kind: 'notify_convex',
				event: {
					event: 'sent',
					messageId: job.messageId,
					organizationId: job.organizationId,
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
	ctx: AttemptCtx,
): OutcomeReduction {
	const { job, ip, pool, domain, durationMs } = ctx;
	return {
		effects: [
			{ kind: 'circuit_breaker_outcome', orgId: job.organizationId, outcome: 'bounced' },
			{ kind: 'smtp_response', domain, smtpCode: outcome.smtpCode, enhancedCode: outcome.enhancedCode },
			{ kind: 'domain_throttle_reject', ip, domain },
			{ kind: 'warming_record', ip, result: 'bounce' },
			{ kind: 'metrics_record', domain, ip, pool: job.ipPool, outcome: 'bounced', durationMs },
			{
				kind: 'log_delivery_event',
				event: {
					messageId: job.messageId,
					to: job.to,
					from: job.from,
					orgId: job.organizationId,
					status: 'bounced',
					bounceType: 'hard',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.error,
					ip,
					pool,
					domain,
					durationMs,
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
	ctx: AttemptCtx,
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
	const { job, ip, pool, domain, durationMs } = ctx;
	return {
		effects: [
			{ kind: 'domain_throttle_defer', ip, domain },
			{ kind: 'smtp_response', domain, smtpCode: outcome.smtpCode, enhancedCode: outcome.enhancedCode },
			{ kind: 'warming_record', ip, result: 'deferral' },
			{ kind: 'metrics_record', domain, ip, pool: job.ipPool, outcome: 'deferred', durationMs },
			{
				kind: 'log_delivery_event',
				event: {
					messageId: job.messageId,
					to: job.to,
					from: job.from,
					orgId: job.organizationId,
					status: 'deferred',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.error,
					ip,
					pool,
					domain,
					durationMs,
					category: outcome.classification.category,
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
	ctx: AttemptCtx,
): OutcomeReduction {
	const { job, ip, pool, domain, durationMs } = ctx;
	return {
		effects: [
			{ kind: 'circuit_breaker_outcome', orgId: job.organizationId, outcome: 'bounced' },
			{ kind: 'smtp_response', domain, smtpCode: outcome.smtpCode, enhancedCode: outcome.enhancedCode },
			{ kind: 'domain_throttle_reject', ip, domain },
			{ kind: 'warming_record', ip, result: 'bounce' },
			{ kind: 'metrics_record', domain, ip, pool: job.ipPool, outcome: 'bounced', durationMs },
			{
				kind: 'log_delivery_event',
				event: {
					messageId: job.messageId,
					to: job.to,
					from: job.from,
					orgId: job.organizationId,
					status: 'bounced',
					bounceType: 'hard',
					smtpCode: outcome.smtpCode,
					smtpResponse: outcome.error,
					ip,
					pool,
					domain,
					durationMs,
					category: outcome.classification.category,
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

function reduceSoftBounce(
	outcome: Extract<DispatchOutcome, { kind: 'soft_bounce' }>,
	ctx: AttemptCtx,
): OutcomeReduction {
	const { job, ip, pool, domain, durationMs } = ctx;
	return {
		effects: [
			{ kind: 'circuit_breaker_outcome', orgId: job.organizationId, outcome: 'bounced' },
			{ kind: 'warming_record', ip, result: 'bounce' },
			{ kind: 'domain_failure_record', domain },
			{ kind: 'metrics_record', domain, ip, pool: job.ipPool, outcome: 'error', durationMs },
			{
				kind: 'log_delivery_event',
				event: {
					messageId: job.messageId,
					to: job.to,
					from: job.from,
					orgId: job.organizationId,
					status: 'failed',
					smtpResponse: outcome.error,
					ip,
					pool,
					domain,
					durationMs,
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
