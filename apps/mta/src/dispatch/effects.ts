/**
 * Dispatch effect — the typed effect variants emitted by the **Dispatch
 * outcome** reducer (and by the pipeline drop path).
 *
 * Each variant maps to one call against an existing intelligence/scaling/
 * monitoring helper. The runner is the only place that imports those
 * helpers; the reducer and the pipeline phases stay substrate-agnostic.
 *
 * Preserved behavior from the pre-deepening handler:
 * - "Tracking" effects (domain throttle, smtp response, circuit breaker,
 *   warming, metrics, domain failure) run in parallel via `Promise.all`.
 * - `log_delivery_event` and `notify_convex` are fire-and-forget — they're
 *   started, error handling is attached, and the runner does not await
 *   their completion. `notify_convex` retries internally for up to ~6
 *   minutes; awaiting it would block worker progress.
 * - `suppress_recipient` is sequential after the parallel batch — matches
 *   the current handler's `await suppressionList.suppress(...)` after the
 *   Promise.all + fire-and-forget log/notify in the hard-bounce branch.
 *
 * See ADR-0007 and CONTEXT.md's MTA dispatch section.
 */

import * as circuitBreaker from '../intelligence/circuitBreaker.js';
import * as campaignComplaintRate from '../intelligence/campaignComplaintRate.js';
import * as domainThrottle from '../intelligence/domainThrottle.js';
import * as smtpResponse from '../intelligence/smtpResponse.js';
import * as warming from '../intelligence/warming.js';
import * as suppressionList from '../intelligence/suppressionList.js';
import { clearDomainFailure, recordDomainFailure } from '../scaling/degradation.js';
import * as metrics from '../monitoring/collector.js';
import { logDeliveryEvent } from '../monitoring/deliveryLogger.js';
import type { DeliveryEvent } from '../monitoring/deliveryLogger.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import type { MtaWebhookEvent, MetricOutcome } from '../types.js';
import type { SuppressionReason } from '../intelligence/suppressionList.js';
import { logger } from '../monitoring/logger.js';
import type { PhaseDeps } from './types.js';

/**
 * Discriminated union of MTA dispatch effects.
 */
export type DispatchEffect =
	| { kind: 'domain_throttle_success'; ip: string; throttleKey: string; providerKey: string }
	| { kind: 'domain_throttle_reject'; ip: string; throttleKey: string }
	| { kind: 'domain_throttle_defer'; ip: string; throttleKey: string; providerKey: string }
	| { kind: 'smtp_response'; domain: string; smtpCode: number; enhancedCode: string | undefined }
	| {
			kind: 'circuit_breaker_outcome';
			orgId: string;
			outcome: 'delivered' | 'bounced' | 'complained';
			providerKey?: string;
	  }
	| {
			/**
			 * Bump a campaign's delivered counter — the denominator for the
			 * per-campaign complaint rate the bounce side tracks (PR-15). Only
			 * emitted when the job carries a campaign-stream `Feedback-ID`.
			 */
			kind: 'campaign_delivery_record';
			campaignId: string;
	  }
	| {
			kind: 'warming_record';
			ip: string;
			result: 'send' | 'bounce' | 'deferral';
			reservedMessageId?: string;
	  }
	| {
			kind: 'metrics_record';
			domain: string;
			ip: string;
			pool: string;
			outcome: MetricOutcome;
			durationMs: number | undefined;
			providerKey: string;
	  }
	| {
			kind: 'metrics_counter_inc';
			pool: string;
			isp: string;
			outcome: MetricOutcome;
	  }
	| { kind: 'log_delivery_event'; event: DeliveryEvent }
	| { kind: 'notify_convex'; event: MtaWebhookEvent }
	| { kind: 'suppress_recipient'; address: string; reason: SuppressionReason }
	| { kind: 'domain_failure_clear'; domain: string }
	| { kind: 'domain_failure_record'; domain: string };

/**
 * Apply a list of effects.
 *
 * Effects are partitioned into three buckets:
 * 1. `parallel` — awaited via `Promise.all`.
 * 2. `fireAndForget` — started with attached error handling; not awaited.
 * 3. `sequential` — awaited after the parallel batch resolves.
 *
 * The partitioning preserves the exact behavior of the pre-deepening
 * handler, including the suppression-after-bounce ordering.
 */
export async function applyEffects(
	effects: ReadonlyArray<DispatchEffect>,
	deps: PhaseDeps
): Promise<void> {
	const parallel: Array<Promise<unknown>> = [];
	const sequential: DispatchEffect[] = [];

	for (const effect of effects) {
		if (effect.kind === 'log_delivery_event' || effect.kind === 'notify_convex') {
			// Fire-and-forget — start now, attach error handling, do not await
			fireAndForget(effect, deps);
			continue;
		}
		if (effect.kind === 'suppress_recipient') {
			sequential.push(effect);
			continue;
		}
		parallel.push(applyOne(effect, deps));
	}

	await Promise.all(parallel);

	for (const effect of sequential) {
		await applyOne(effect, deps);
	}
}

function fireAndForget(
	effect: Extract<DispatchEffect, { kind: 'log_delivery_event' | 'notify_convex' }>,
	deps: PhaseDeps
): void {
	if (effect.kind === 'log_delivery_event') {
		logDeliveryEvent(deps.redis, effect.event, deps.config).catch(() => {});
		return;
	}
	notifyConvex(effect.event, deps.config, deps.redis).catch((err) =>
		logger.error(
			{ err, event: effect.event.event, messageId: effect.event.messageId },
			'Failed to notify Convex'
		)
	);
}

function applyOne(effect: DispatchEffect, deps: PhaseDeps): Promise<unknown> {
	switch (effect.kind) {
		case 'domain_throttle_success':
			return domainThrottle.recordSuccess(
				deps.redis,
				effect.ip,
				effect.throttleKey,
				effect.providerKey
			);
		case 'domain_throttle_reject':
			return domainThrottle.recordReject(deps.redis, effect.ip, effect.throttleKey);
		case 'domain_throttle_defer':
			return domainThrottle.recordDefer(
				deps.redis,
				effect.ip,
				effect.throttleKey,
				effect.providerKey
			);
		case 'smtp_response':
			return smtpResponse.recordResponse(
				deps.redis,
				effect.domain,
				effect.smtpCode,
				effect.enhancedCode
			);
		case 'circuit_breaker_outcome':
			return effect.providerKey
				? circuitBreaker.recordOutcome(
						deps.redis,
						effect.orgId,
						effect.outcome,
						deps.config,
						effect.providerKey
					)
				: circuitBreaker.recordOutcome(deps.redis, effect.orgId, effect.outcome, deps.config);
		case 'campaign_delivery_record':
			return campaignComplaintRate
				.recordDelivery(deps.redis, effect.campaignId)
				.catch((err) =>
					logger.warn({ err, campaignId: effect.campaignId }, 'Failed to record campaign delivery')
				);
		case 'warming_record':
			if (effect.result === 'send')
				return warming.recordSend(deps.redis, effect.ip, effect.reservedMessageId);
			if (effect.result === 'bounce') return warming.recordBounce(deps.redis, effect.ip);
			return warming.recordDeferral(deps.redis, effect.ip);
		case 'metrics_record':
			return metrics.record(
				deps.redis,
				effect.domain,
				effect.ip,
				effect.pool,
				effect.outcome,
				effect.durationMs,
				effect.providerKey
			);
		case 'metrics_counter_inc':
			metrics.emailsSentTotal.inc({
				pool: effect.pool,
				isp: effect.isp,
				outcome: effect.outcome,
			});
			return Promise.resolve();
		case 'suppress_recipient':
			return suppressionList.suppress(deps.redis, effect.address, effect.reason);
		case 'domain_failure_clear':
			return clearDomainFailure(deps.redis, effect.domain);
		case 'domain_failure_record':
			return recordDomainFailure(deps.redis, effect.domain);
		// These two are handled by `fireAndForget` above; this branch only
		// exists to make the switch exhaustive at the type level.
		case 'log_delivery_event':
		case 'notify_convex':
			return Promise.resolve();
	}
}
