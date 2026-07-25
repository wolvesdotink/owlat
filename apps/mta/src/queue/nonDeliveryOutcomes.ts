/**
 * Terminal outcomes for a job that never opened an SMTP conversation.
 *
 * A screened or suppressed message is dropped by the pipeline before dispatch,
 * and an over-age message is given up on between deferrals. Neither reached
 * the wire, which is what these two paths have in common and why they share a
 * module: both must emit exactly one Convex terminal callback whose payload is
 * a function of durable job state (the protected outbox compares payloads
 * byte-for-byte, so a replay that stamps a fresh clock dead-letters the job),
 * and both must hand back the warming slot and half-open breaker probe they
 * reserved but never spent.
 */

import type { ReservedJob } from 'groupmq';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { DestinationProviderKey, EmailJob } from '../types.js';
import type { DeliveryEvent } from '../monitoring/deliveryLogger.js';
import type { DispatchEffect } from '../dispatch/effects.js';
import { applyEffects } from '../dispatch/effects.js';
import type { PipelineResult } from '../dispatch/pipeline.js';
import type { BasePhaseCtx } from '../dispatch/types.js';
import { logger } from '../monitoring/logger.js';
import { releaseRoutingReservations } from './routingReservations.js';

type DropResult = Extract<PipelineResult<BasePhaseCtx>, { kind: 'drop' }>;

/**
 * Emit the terminal expired-bounce once the max message age is exceeded.
 * Recorded as a soft bounce (the message kept being transiently deferred) so
 * downstream bounce handling treats it as a give-up rather than a permanent
 * address failure.
 */
export async function emitExpiredBounce(
	job: ReservedJob<EmailJob>,
	deps: { redis: Redis; config: MtaConfig },
	domain: string,
	providerKey: DestinationProviderKey,
	ageMs: number,
	reason: string
): Promise<void> {
	const data = job.data;
	// Anchor the terminal notification to the job's own expiry deadline rather
	// than the observing run's wall clock, so every replay rebuilds it exactly.
	const expiredAt = (data.firstEnqueuedAt ?? job.timestamp) + deps.config.maxMessageAgeMs;
	logger.warn(
		{ messageId: data.messageId, to: data.to, domain, ageMs, reason },
		'Message exceeded max age — giving up with expired-bounce'
	);

	const effects: DispatchEffect[] = [
		{
			kind: 'log_delivery_event',
			event: {
				messageId: data.messageId,
				to: data.to,
				from: data.from,
				orgId: data.organizationId,
				status: 'expired',
				bounceType: 'soft',
				domain,
				provider: providerKey,
				pool: data.ipPool,
				reason: `Expired after ${ageMs}ms: ${reason}`,
			},
		},
		{
			kind: 'notify_convex',
			event: {
				event: 'bounced',
				messageId: data.messageId,
				organizationId: data.organizationId,
				deliveryDomain: data.deliveryDomain,
				bounceType: 'soft',
				message: `Message expired after ${deps.config.maxMessageAgeMs}ms without delivery`,
				timestamp: expiredAt,
			},
		},
	];

	await applyEffects(effects, deps);
	// Nothing reached the wire, so holding the slot burns real capacity for the
	// rest of the UTC day on exactly the warming IPs that can least afford it.
	await releaseRoutingReservations(data, deps);
}

/**
 * Apply the side effects for a pipeline drop. Status-specific:
 *   - `screened`: warn log, Prometheus rejected-counter inc, delivery log.
 *   - `suppressed`: info log, delivery log.
 */
export async function handleDrop(
	piped: DropResult,
	job: EmailJob,
	deps: { redis: Redis; config: MtaConfig },
	drop: {
		domain: string;
		providerKey: DestinationProviderKey;
		/** Stable across replays — the protected outbox compares payloads exactly. */
		droppedAt: number;
	}
): Promise<void> {
	const { domain, providerKey, droppedAt } = drop;
	const effects: DispatchEffect[] = [];

	if (piped.status === 'screened') {
		logger.warn(
			{ messageId: job.messageId, to: job.to, reason: piped.reason },
			'Content screening rejected'
		);
		if (job.deliveryDomain !== 'member_test') {
			effects.push({
				kind: 'metrics_counter_inc',
				pool: job.ipPool,
				isp: providerKey,
				outcome: 'rejected',
			});
		}
	} else {
		logger.info({ messageId: job.messageId, to: job.to }, 'Recipient suppressed — skipping');
	}

	effects.push({
		kind: 'log_delivery_event',
		event: buildDropEvent(piped, job, domain, providerKey),
	});
	effects.push({
		kind: 'notify_convex',
		event: {
			event: 'failed',
			messageId: job.messageId,
			organizationId: job.organizationId,
			deliveryDomain: job.deliveryDomain,
			// The screening reason carries a live rspamd score, which is
			// re-evaluated on a replay and would break the outbox payload
			// comparison. The exact score stays in the delivery log above.
			message:
				piped.status === 'screened'
					? 'Content screening rejected the message'
					: 'Recipient suppressed by MTA policy',
			errorCode: piped.status === 'screened' ? 'CONTENT_SCREENED' : 'RECIPIENT_SUPPRESSED',
			timestamp: droppedAt,
		},
	});

	await applyEffects(effects, deps);
	// Screening and suppression drop the message before any SMTP conversation,
	// so the reserved warming slot and half-open probe were never consumed.
	await releaseRoutingReservations(job, deps);
}

function buildDropEvent(
	piped: DropResult,
	job: EmailJob,
	domain: string,
	providerKey: DestinationProviderKey
): DeliveryEvent {
	const base: DeliveryEvent = {
		messageId: job.messageId,
		to: job.to,
		from: job.from,
		orgId: job.organizationId,
		status: piped.status,
		domain,
		provider: providerKey,
		pool: job.ipPool,
	};
	if (piped.status === 'screened') {
		return { ...base, reason: piped.reason };
	}
	return base;
}
