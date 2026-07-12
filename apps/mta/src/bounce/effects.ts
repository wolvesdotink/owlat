/**
 * Bounce effect — the typed effect variants emitted by the **Bounce
 * outcome** reducer.
 *
 * Each variant maps to one call against an existing helper. The runner is
 * the only place that imports those helpers; the reducer and the pipeline
 * phases stay substrate-agnostic.
 *
 * Preserved behavior from the pre-deepening server (`bounce/server.ts`
 * onData):
 * - "Tracking" effects (circuit breaker, FBL stats, metrics counters,
 *   attachment staging, endpoint forwarding) run in parallel via
 *   `Promise.all`.
 * - `notify_convex` is fire-and-forget (matching `dispatch/effects.ts:118`).
 *   The pre-deepening server awaited it inline, which put the Convex
 *   round-trip in the SMTP ACK budget — the new runner removes that.
 * - `mailbox_quota_bump` is fire-and-forget — matches the original's
 *   `bumpUsedBytes(...).catch(() => undefined)` orphan.
 *
 * See ADR-0007 follow-up #4 and CONTEXT.md's MTA dispatch section.
 */

import type { ParsedMail } from 'mailparser';
import * as circuitBreaker from '../intelligence/circuitBreaker.js';
import * as campaignComplaintRate from '../intelligence/campaignComplaintRate.js';
import * as metrics from '../monitoring/collector.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { forwardToEndpoint } from '../inbound/forwarder.js';
import { bumpUsedBytes } from '../inbound/mailboxResolver.js';
import { logger } from '../monitoring/logger.js';
import type { InboundAuthVerdicts, MtaWebhookEvent } from '../types.js';
import type { InboundRoute } from '../inbound/router.js';
import type { PhaseDeps } from './types.js';

/**
 * Discriminated union of Bounce intake effects.
 *
 * `metric_inc` carries a nested `metric` discriminator so the runner can
 * statically route to the right Prometheus counter without a `switch (key)`
 * over arbitrary strings.
 */
export type BounceEffect =
	| {
			kind: 'circuit_breaker_outcome';
			orgId: string;
			outcome: 'complained';
	  }
	| {
			kind: 'metric_inc';
			metric: 'fbl_complaint';
			isp: string;
			attributed: 'yes' | 'no';
	  }
	| {
			kind: 'metric_inc';
			metric: 'fbl_complaint_by_campaign';
			campaign: string;
			isp: string;
	  }
	| {
			kind: 'metric_inc';
			metric: 'unattributed_bounce';
	  }
	| {
			kind: 'fbl_stats_record';
	  }
	| {
			/**
			 * Record a complaint against a campaign's rolling rate window and, on
			 * crossing the 0.3% threshold, alert Convex. Captures complaints that
			 * carry a `Feedback-ID` campaignId even when no org id was extractable —
			 * the gap the org-only circuit breaker leaves open.
			 */
			kind: 'campaign_complaint_record';
			campaignId: string;
			/** Carried through to the alert payload for org-level correlation. */
			organizationId?: string;
	  }
	| {
			kind: 'notify_convex';
			event: MtaWebhookEvent;
	  }
	| {
			kind: 'stage_attachment';
			redisKey: string;
			contentBase64: string;
			ttlSeconds: number;
	  }
	| {
			kind: 'mailbox_quota_bump';
			address: string;
			deltaBytes: number;
	  }
	| {
			kind: 'forward_to_endpoint';
			route: InboundRoute;
			parsed: ParsedMail;
			rcptTo: string;
			/** RFC 8601 inbound auth verdicts + DMARC alignment inputs. */
			auth?: InboundAuthVerdicts;
	  };

/**
 * Apply a list of effects.
 *
 * Effects are partitioned into two buckets:
 * 1. `parallel` — awaited via `Promise.all`.
 * 2. `fireAndForget` — started with attached error handling; not awaited.
 *
 * The partitioning preserves the exact behavior of the pre-deepening
 * onData handler, except that `notify_convex` moves from "awaited" to
 * "fire-and-forget" (the documented win in ADR-0007 follow-up #4).
 */
export async function applyEffects(
	effects: ReadonlyArray<BounceEffect>,
	deps: PhaseDeps
): Promise<void> {
	const parallel: Array<Promise<unknown>> = [];

	for (const effect of effects) {
		if (effect.kind === 'notify_convex' || effect.kind === 'mailbox_quota_bump') {
			fireAndForget(effect, deps);
			continue;
		}
		parallel.push(applyOne(effect, deps));
	}

	await Promise.all(parallel);
}

function fireAndForget(
	effect: Extract<BounceEffect, { kind: 'notify_convex' | 'mailbox_quota_bump' }>,
	deps: PhaseDeps
): void {
	if (effect.kind === 'notify_convex') {
		notifyConvex(effect.event, deps.config, deps.redis).catch((err) =>
			logger.error(
				{ err, event: effect.event.event, messageId: effect.event.messageId },
				'Failed to notify Convex'
			)
		);
		return;
	}
	bumpUsedBytes(deps.redis, effect.address, effect.deltaBytes).catch(() => undefined);
}

function applyOne(effect: BounceEffect, deps: PhaseDeps): Promise<unknown> {
	switch (effect.kind) {
		case 'circuit_breaker_outcome':
			return circuitBreaker.recordOutcome(deps.redis, effect.orgId, effect.outcome, deps.config);
		case 'metric_inc':
			if (effect.metric === 'fbl_complaint') {
				metrics.fblComplaintsTotal.inc({ isp: effect.isp, attributed: effect.attributed });
			} else if (effect.metric === 'fbl_complaint_by_campaign') {
				metrics.fblComplaintsByCampaignTotal.inc({ campaign: effect.campaign, isp: effect.isp });
			} else {
				metrics.unattributedBouncesTotal.inc();
			}
			return Promise.resolve();
		case 'campaign_complaint_record':
			return recordCampaignComplaint(effect, deps);
		case 'fbl_stats_record': {
			const today = new Date().toISOString().split('T')[0];
			return deps.redis.hincrby(`mta:fbl-stats:${today}`, 'total', 1).catch(() => {
				// Non-critical — daily stats counter; missing increments are tolerable.
			});
		}
		case 'stage_attachment':
			return deps.redis
				.setex(effect.redisKey, effect.ttlSeconds, effect.contentBase64)
				.catch((err: unknown) => {
					logger.warn({ err, redisKey: effect.redisKey }, 'Failed to stage attachment in Redis');
				});
		case 'forward_to_endpoint':
			return forwardToEndpoint(effect.parsed, effect.route, effect.rcptTo, effect.auth);
		// These two are handled by `fireAndForget` above; this branch only
		// exists to make the switch exhaustive at the type level.
		case 'notify_convex':
		case 'mailbox_quota_bump':
			return Promise.resolve();
	}
}

/**
 * Record a complaint against the campaign's rolling rate window. When the
 * complaint pushes the campaign over the 0.3% threshold for the first time, fire
 * a `campaign.complaint_rate` alert to Convex. Both steps are best-effort:
 * Redis or Convex being unavailable must never block the SMTP ACK.
 */
async function recordCampaignComplaint(
	effect: Extract<BounceEffect, { kind: 'campaign_complaint_record' }>,
	deps: PhaseDeps
): Promise<void> {
	let result;
	try {
		result = await campaignComplaintRate.recordComplaint(deps.redis, effect.campaignId);
	} catch (err) {
		logger.warn({ err, campaignId: effect.campaignId }, 'Failed to record campaign complaint');
		return;
	}

	if (!result.thresholdCrossed) return;

	const ratePct = (result.rate * 100).toFixed(2);
	logger.warn(
		{
			campaignId: effect.campaignId,
			rate: result.rate,
			complaints: result.complaints,
			delivered: result.delivered,
		},
		'Campaign complaint rate exceeded threshold'
	);

	notifyConvex(
		{
			event: 'campaign.complaint_rate',
			campaignId: effect.campaignId,
			organizationId: effect.organizationId,
			complaintRate: result.rate,
			message: `Campaign complaint rate ${ratePct}% exceeded ${(campaignComplaintRate.CAMPAIGN_COMPLAINT_THRESHOLD * 100).toFixed(1)}% threshold (${result.complaints}/${result.delivered})`,
			severity: 'critical',
			timestamp: Date.now(),
		},
		deps.config,
		deps.redis
	).catch((err) =>
		logger.error(
			{ err, campaignId: effect.campaignId },
			'Failed to alert Convex of campaign complaint rate'
		)
	);
}
