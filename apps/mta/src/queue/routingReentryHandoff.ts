/** Durable ownership transfer from an MTA worker back to governed Convex routing. */

import type Redis from 'ioredis';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { MtaConfig } from '../config.js';
import type { EmailJob, MtaWebhookEvent } from '../types.js';
import { logger } from '../monitoring/logger.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';
import { releaseRoutingReservations } from './routingReservations.js';

type RoutingReentryReason =
	| 'routing_lease_stale'
	| 'circuit_breaker_changed'
	| 'warming_capacity_changed';

/**
 * Handing a message back to Convex ends this worker's ownership, but GroupMQ
 * only records completion after the handler returns. Without a durable record
 * of the handoff a crash in that window redelivers the job, the whole pipeline
 * re-runs against fresh capacity (the warming trigger is precisely the
 * cross-midnight case), and the recipient receives the message twice — once
 * from this replay and once from the successor Convex already enqueued.
 *
 * The receipt is that fence: `reserved` means the handoff may be incomplete
 * (finish it idempotently), `accepted` means the protected outbox already owns
 * the successor and this job must not re-enter dispatch. It mirrors the defer
 * handoff, which fences the same ownership transfer for deferrals.
 */
interface RoutingReentryHandoffReceipt {
	state: 'reserved' | 'accepted';
	messageId: string;
	workAttemptId: string;
	routingReentryReason: RoutingReentryReason;
	/** Frozen so every replay rebuilds a byte-identical protected outbox payload. */
	timestamp: number;
	reservedAt: number;
	acceptedAt?: number;
}

function handoffKey(jobId: string): string {
	return `mta:routing-reentry-handoffs:${jobId}`;
}

function parseReceipt(raw: string | null): RoutingReentryHandoffReceipt | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			(value['state'] === 'reserved' || value['state'] === 'accepted') &&
			typeof value['messageId'] === 'string' &&
			typeof value['workAttemptId'] === 'string' &&
			(value['routingReentryReason'] === 'routing_lease_stale' ||
				value['routingReentryReason'] === 'circuit_breaker_changed' ||
				value['routingReentryReason'] === 'warming_capacity_changed') &&
			typeof value['timestamp'] === 'number' &&
			typeof value['reservedAt'] === 'number'
		) {
			return value as unknown as RoutingReentryHandoffReceipt;
		}
	} catch {
		// A corrupt receipt is never positive evidence of a completed handoff.
	}
	return null;
}

export function classifyRoutingReentryReason(reason: string): RoutingReentryReason {
	if (/warming/i.test(reason)) return 'warming_capacity_changed';
	if (/circuit/i.test(reason)) return 'circuit_breaker_changed';
	return 'routing_lease_stale';
}

function buildReentryEvent(job: EmailJob, receipt: RoutingReentryHandoffReceipt): MtaWebhookEvent {
	if (!job.routingReentryToken || !job.routingReentry || !job.workAttemptId) {
		throw new Error('Missing routing re-entry context');
	}
	return {
		event: 'routing.reentry',
		messageId: job.messageId,
		routingReentryToken: job.routingReentryToken,
		workAttemptId: job.workAttemptId,
		deliveryDomain: job.deliveryDomain,
		routingReentry: job.routingReentry,
		routingReentryReason: receipt.routingReentryReason,
		timestamp: receipt.timestamp,
	};
}

/**
 * Persist the successor and mark the handoff accepted. Safe to repeat: the
 * outbox id is deterministic and the payload is frozen in the receipt, so a
 * second call observes the existing row instead of colliding with it.
 */
async function completeHandoff(
	job: EmailJob,
	deps: { redis: Redis; config: MtaConfig },
	jobId: string,
	raw: string,
	receipt: RoutingReentryHandoffReceipt
): Promise<void> {
	const event = buildReentryEvent(job, receipt);
	await releaseRoutingReservations(job, deps);
	const outboxId = await queueConvexWebhook(
		event,
		deps.config,
		deps.redis,
		`routing-reentry:${receipt.workAttemptId}:${job.routingReentryToken}`
	);
	const accepted = JSON.stringify({
		...receipt,
		state: 'accepted',
		acceptedAt: Date.now(),
	} satisfies RoutingReentryHandoffReceipt);
	await deps.redis.eval(
		"if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end return 1",
		1,
		handoffKey(jobId),
		raw,
		accepted,
		String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
	);
	logger.warn(
		{ messageId: job.messageId, routingReentryReason: receipt.routingReentryReason, outboxId },
		'Routing re-entry transferred to the protected webhook outbox'
	);
}

export async function handoffRoutingReentry(
	job: EmailJob,
	deps: { redis: Redis; config: MtaConfig },
	reason: string,
	jobId: string
): Promise<void> {
	if (!job.routingReentryToken || !job.routingReentry || !job.workAttemptId) {
		throw new Error('Missing routing re-entry context');
	}
	const now = Date.now();
	const reserved: RoutingReentryHandoffReceipt = {
		state: 'reserved',
		messageId: job.messageId,
		workAttemptId: job.workAttemptId,
		routingReentryReason: classifyRoutingReentryReason(reason),
		timestamp: now,
		reservedAt: now,
	};
	const raw = JSON.stringify(reserved);
	const claimed = await deps.redis.set(
		handoffKey(jobId),
		raw,
		'PX',
		GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		'NX'
	);
	if (claimed === 'OK') {
		await completeHandoff(job, deps, jobId, raw, reserved);
		return;
	}
	// An earlier run of this job already reserved the handoff. Finish that one
	// so the outbox payload stays identical instead of starting a second one.
	if (!(await resumeRoutingReentryHandoff(deps.redis, jobId, job, deps))) {
		throw new Error('Routing re-entry handoff receipt is unreadable');
	}
}

/**
 * Resume a handoff owned by an earlier run of the same job. Returns true when
 * this job has already surrendered ownership and must not re-enter dispatch.
 */
export async function resumeRoutingReentryHandoff(
	redis: Redis,
	jobId: string,
	job: EmailJob,
	deps: { redis: Redis; config: MtaConfig }
): Promise<boolean> {
	const raw = await redis.get(handoffKey(jobId));
	const receipt = parseReceipt(raw);
	if (!raw || !receipt) return false;
	if (receipt.messageId !== job.messageId) {
		throw new Error('Routing re-entry handoff is bound to another message');
	}
	if (receipt.state === 'accepted') return true;
	await completeHandoff(job, deps, jobId, raw, receipt);
	return true;
}
