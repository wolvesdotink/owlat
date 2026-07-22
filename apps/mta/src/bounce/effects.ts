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
 *   attachment staging, endpoint forwarding) start in parallel and all settle
 *   before a deterministic first failure is surfaced.
 * - Attributed DSN/FBL terminal callbacks persist to the durable outbox before
 *   SMTP ACK. Other inbound callbacks remain fire-and-forget.
 * - `mailbox_quota_bump` is fire-and-forget — matches the original's
 *   `bumpUsedBytes(...).catch(() => undefined)` orphan.
 *
 * See ADR-0007 follow-up #4 and CONTEXT.md's MTA dispatch section.
 */

import type { ParsedMessage } from '@owlat/mail-message';
import * as circuitBreaker from '../intelligence/circuitBreaker.js';
import * as campaignComplaintRate from '../intelligence/campaignComplaintRate.js';
import * as metrics from '../monitoring/collector.js';
import { notifyConvex, queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { forwardToEndpoint } from '../inbound/forwarder.js';
import { bumpUsedBytes } from '../inbound/mailboxResolver.js';
import { logger } from '../monitoring/logger.js';
import type { InboundAuthVerdicts, MtaWebhookEvent } from '../types.js';
import type { InboundRoute } from '../inbound/router.js';
import type { PhaseDeps } from './types.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';
import { settleStartedEffects } from '../lib/settleStartedEffects.js';
import {
	DURABLE_EFFECT_IDEMPOTENCY_TTL_MS,
	type DurableEffectIdentity,
} from '../lib/effectCheckpoint.js';
import { createHash } from 'crypto';

const RECORD_FBL_STAT_ONCE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HINCRBY', KEYS[1], 'total', 1)
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], 'recorded', 'PX', ARGV[2])
return 1
`;

export function fblStatsKey(utcDate: string): string {
	return `mta:fbl-stats:{${utcDate}}:counts`;
}

function fblStatsReceiptKey(utcDate: string, identity: DurableEffectIdentity): string {
	return `mta:fbl-stats:{${utcDate}}:effect:${createHash('sha256').update(identity).digest('hex')}`;
}

export interface BounceEffectReplayGuard {
	runSecondary<T>(
		effectIdentity: string,
		apply: (downstreamIdentity: DurableEffectIdentity) => Promise<T>
	): Promise<T | undefined>;
}

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
			parsed: ParsedMessage;
			rcptTo: string;
			/** RFC 8601 inbound auth verdicts + DMARC alignment inputs. */
			auth?: InboundAuthVerdicts;
	  };

/** Signals the one inbound failure for which SMTP must request a retry. */
export class DurableFeedbackPersistenceError extends TransientFeedbackProcessingError {
	constructor(cause: unknown) {
		super('Attributed feedback could not be persisted durably', cause);
		this.name = 'DurableFeedbackPersistenceError';
	}
}

/**
 * Apply a list of effects.
 *
 * Effects are partitioned into two buckets:
 * 1. `parallel` — all started, then settled before the first failure is surfaced.
 * 2. `fireAndForget` — started with attached error handling; not awaited.
 *
 * The partitioning preserves the exact behavior of the pre-deepening
 * onData handler, except that `notify_convex` moves from "awaited" to
 * "fire-and-forget" (the documented win in ADR-0007 follow-up #4).
 */
export async function applyEffects(
	effects: ReadonlyArray<BounceEffect>,
	deps: PhaseDeps,
	replayGuard?: BounceEffectReplayGuard
): Promise<void> {
	const durableTerminal: Array<Promise<unknown>> = [];
	const remaining: BounceEffect[] = [];

	for (const effect of effects) {
		if (
			effect.kind === 'notify_convex' &&
			effect.event.messageId &&
			(effect.event.event === 'bounced' || effect.event.event === 'complained')
		) {
			durableTerminal.push(
				queueConvexWebhook(
					effect.event,
					deps.config,
					deps.redis,
					feedbackOutboxIdentity(effect.event)
				).catch((err) => {
					throw new DurableFeedbackPersistenceError(err);
				})
			);
			continue;
		}
		remaining.push(effect);
	}

	// Feedback bytes must not be SMTP-ACKed until their attributed terminal
	// callback is durable. Complete this phase before even starting best-effort
	// effects so an unrelated rejection cannot mask the typed failure.
	await settleStartedEffects(durableTerminal);

	const parallel: Array<Promise<unknown>> = [];
	for (const [index, effect] of remaining.entries()) {
		if (effect.kind === 'notify_convex' || effect.kind === 'mailbox_quota_bump') {
			fireAndForget(effect, deps);
			continue;
		}
		const apply = (downstreamIdentity?: DurableEffectIdentity) =>
			applyOne(effect, deps, downstreamIdentity);
		parallel.push(
			replayGuard ? replayGuard.runSecondary(`${index}:${effect.kind}`, apply) : apply()
		);
	}
	// Do not release or complete the parent complaint reservation while a
	// sibling still owns a child effect lease. Failures are surfaced only after
	// every effect that was started has settled, in deterministic input order.
	await settleStartedEffects(parallel);
}

function feedbackOutboxIdentity(event: MtaWebhookEvent): string {
	const bounceType = event.event === 'bounced' ? `:${event.bounceType ?? 'unknown'}` : '';
	return `feedback:${event.messageId}:${event.event}${bounceType}`;
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

function applyOne(
	effect: BounceEffect,
	deps: PhaseDeps,
	downstreamIdentity?: DurableEffectIdentity
): Promise<unknown> {
	switch (effect.kind) {
		case 'circuit_breaker_outcome':
			return retryableComplaintEffect(
				downstreamIdentity
					? circuitBreaker.recordOutcome(
							deps.redis,
							effect.orgId,
							effect.outcome,
							deps.config,
							undefined,
							undefined,
							downstreamIdentity
						)
					: circuitBreaker.recordOutcome(deps.redis, effect.orgId, effect.outcome, deps.config),
				downstreamIdentity,
				'Circuit-breaker complaint outcome is uncertain'
			);
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
			return recordCampaignComplaint(effect, deps, downstreamIdentity);
		case 'fbl_stats_record': {
			const today = new Date().toISOString().split('T')[0]!;
			if (downstreamIdentity) {
				return deps.redis.eval(
					RECORD_FBL_STAT_ONCE_LUA,
					2,
					fblStatsKey(today),
					fblStatsReceiptKey(today, downstreamIdentity),
					'172800',
					String(DURABLE_EFFECT_IDEMPOTENCY_TTL_MS)
				);
			}
			return deps.redis.hincrby(fblStatsKey(today), 'total', 1).catch(() => {
				// Non-critical — daily stats counter; missing increments are tolerable.
			});
		}
		case 'stage_attachment':
			if (downstreamIdentity) {
				return deps.redis.setex(effect.redisKey, effect.ttlSeconds, effect.contentBase64);
			}
			return deps.redis
				.setex(effect.redisKey, effect.ttlSeconds, effect.contentBase64)
				.catch((err: unknown) => {
					logger.warn({ err, redisKey: effect.redisKey }, 'Failed to stage attachment in Redis');
				});
		case 'forward_to_endpoint':
			return downstreamIdentity
				? forwardToEndpoint(
						effect.parsed,
						effect.route,
						effect.rcptTo,
						effect.auth,
						downstreamIdentity
					)
				: forwardToEndpoint(effect.parsed, effect.route, effect.rcptTo, effect.auth);
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
 * a `campaign.complaint_rate` alert to Convex. Legacy unguarded calls remain
 * best-effort; guarded complaint replays surface uncertainty so the stable
 * downstream identity can safely retry the Redis increment and alert outbox.
 */
async function recordCampaignComplaint(
	effect: Extract<BounceEffect, { kind: 'campaign_complaint_record' }>,
	deps: PhaseDeps,
	downstreamIdentity?: DurableEffectIdentity
): Promise<void> {
	let result;
	try {
		result = await campaignComplaintRate.recordComplaint(
			deps.redis,
			effect.campaignId,
			downstreamIdentity
		);
	} catch (err) {
		logger.warn({ err, campaignId: effect.campaignId }, 'Failed to record campaign complaint');
		if (downstreamIdentity) {
			throw new TransientFeedbackProcessingError('Campaign complaint outcome is uncertain', err);
		}
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

	const alert: MtaWebhookEvent = {
		event: 'campaign.complaint_rate',
		eventId:
			downstreamIdentity ??
			createHash('sha256')
				.update(
					`${effect.campaignId}\0${result.recordedAt}\0${result.complaints}\0${result.delivered}`
				)
				.digest('hex'),
		campaignId: effect.campaignId,
		organizationId: effect.organizationId,
		complaintRate: result.rate,
		message: `Campaign complaint rate ${ratePct}% exceeded ${(campaignComplaintRate.CAMPAIGN_COMPLAINT_THRESHOLD * 100).toFixed(1)}% threshold (${result.complaints}/${result.delivered})`,
		severity: 'critical',
		timestamp: result.recordedAt,
	};
	if (downstreamIdentity) {
		try {
			await queueConvexWebhook(
				alert,
				deps.config,
				deps.redis,
				`campaign-complaint-alert:${downstreamIdentity}`
			);
		} catch (err) {
			throw new TransientFeedbackProcessingError(
				'Campaign complaint alert persistence is uncertain',
				err
			);
		}
		return;
	}
	notifyConvex(alert, deps.config, deps.redis).catch((err) =>
		logger.error(
			{ err, campaignId: effect.campaignId },
			'Failed to alert Convex of campaign complaint rate'
		)
	);
}

async function retryableComplaintEffect<T>(
	operation: Promise<T>,
	downstreamIdentity: DurableEffectIdentity | undefined,
	message: string
): Promise<T> {
	try {
		return await operation;
	} catch (error) {
		if (downstreamIdentity) throw new TransientFeedbackProcessingError(message, error);
		throw error;
	}
}
