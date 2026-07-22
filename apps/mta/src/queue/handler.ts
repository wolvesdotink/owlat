/**
 * Main Worker Job Handler — GroupMQ adapter for the **Dispatch attempt**.
 *
 * Reads top-to-bottom as the lifecycle of one attempt:
 *   pipeline → send → outcome → effects → defer disposition.
 *
 * Defer disposition is the only GroupMQ-coupling primitive in the dispatch
 * path; the Dispatch pipeline and Dispatch outcome modules never throw and
 * never touch the queue — they return data.
 *
 * Defers are NOT thrown back at GroupMQ's worker. GroupMQ's worker ignores the
 * per-category delay we compute and counts every throw against `maxAttempts`,
 * which dead-letters a warming-capped or greylisted message after ~5 defers.
 * Instead, this handler re-enqueues the job itself with the *computed* delay
 * (greylist 300s, rate-limit 900s, warming-cap, breaker-cooldown, …) and
 * returns normally, so a defer never burns a delivery attempt. The only
 * give-up is the max-message-age cap (RFC 5321 §4.5.4.1), measured from the
 * first enqueue so it survives re-queues.
 *
 * See `docs/adr/0007-mta-dispatch-modules.md` and CONTEXT.md's MTA
 * dispatch section.
 */

import type Redis from 'ioredis';
import type { Queue, ReservedJob } from 'groupmq';
import type { DestinationProviderKey, EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { extractDomain, buildGroupKey } from './groups.js';
import { extractDomainOrNull } from '@owlat/shared';
import { recordWorkerHeartbeat } from '../routes/health.js';
import { logger } from '../monitoring/logger.js';
import { runPipeline } from '../dispatch/pipeline.js';
import { mainPipeline } from '../dispatch/phases/index.js';
import type { DispatchOutcome } from '../dispatch/outcome.js';
import { applyEffects, type DispatchEffect } from '../dispatch/effects.js';
import type { AttemptCtx, BasePhaseCtx } from '../dispatch/types.js';
import type { DeliveryEvent } from '../monitoring/deliveryLogger.js';
import type { PipelineResult } from '../dispatch/pipeline.js';
import { isIpEligibilityLeaseValid } from '../scaling/ipPool.js';
import { resolveDestinationSnapshot } from '../smtp/destinationProvider.js';
import { recordFeedbackProvenance } from '../bounce/feedbackProvenance.js';
import { promoteIntakeReceipt } from '../routes/sendReceipt.js';
import {
	handoffDeferredJob,
	promoteDeferredHandoff,
	resumeDeferredHandoff,
} from './deferHandoff.js';
import { messageAgeMs, withJitter, type DeferKind } from './deferPolicy.js';
import {
	runSmtpSecondaryEffect,
	markSmtpEffectsApplied,
	readSmtpOutcome,
} from './smtpOutcomeJournal.js';
import { resumeJournaledSmtpAttempt, runJournaledSmtpAttempt } from './journaledSmtpAttempt.js';
import { releaseRoutingReservations } from './routingReservations.js';
import { handoffRoutingReentry } from './routingReentryHandoff.js';

/**
 * Process a single email job through the Dispatch pipeline + Dispatch
 * outcome reducer.
 *
 * Resolves normally for every disposition (delivered, dropped, deferred, or
 * expired) — it never throws a defer back at GroupMQ. Deferred jobs are
 * re-enqueued onto `queue` with the computed delay; expired jobs emit a
 * terminal bounce.
 */
export async function handleEmailJob(
	job: ReservedJob<EmailJob>,
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): Promise<void> {
	const data = job.data;
	const deps = { redis, config };
	// This durable CAS closes the route-side queue.add/receipt gap before the
	// worker can perform SMTP or reach a GroupMQ-completable terminal path.
	await promoteIntakeReceipt(redis, data);
	const journalJobId = String(job.id);
	const priorSmtpOutcome = await readSmtpOutcome(redis, journalJobId, data.messageId);
	if (priorSmtpOutcome?.entry.state === 'effects_applied') return;
	if (priorSmtpOutcome) {
		const replay = await resumeJournaledSmtpAttempt(redis, priorSmtpOutcome, data);
		if (replay.kind === 'effects_applied') return;
		await applyCompletedAttempt(replay.journal, job, queue, deps);
		return;
	}
	await promoteDeferredHandoff(redis, data);
	if (await resumeDeferredHandoff(redis, queue, job.id, data)) {
		return;
	}
	const domain = extractDomain(data.to);
	const destination = await resolveDestinationSnapshot(redis, domain, { config });
	const { providerKey } = destination;
	// extractDomainOrNull unwraps a "Name <addr>" From (a raw split would keep
	// the trailing `>`); undefined when no address is present.
	const fromDomain = extractDomainOrNull(data.from) ?? undefined;

	logger.debug(
		{ messageId: data.messageId, to: data.to, domain, pool: data.ipPool },
		'Processing email job'
	);

	recordWorkerHeartbeat(redis, config.serverId).catch(() => {});

	const baseCtx: BasePhaseCtx = {
		job: data,
		domain,
		destination,
		fromDomain,
	};

	const piped = await runPipeline(deps, mainPipeline, baseCtx);

	if (piped.kind === 'drop') {
		await handleDrop(piped, data, domain, providerKey, deps);
		return;
	}

	if (piped.kind === 'routing_reentry') {
		await handoffRoutingReentry(data, deps, piped.reason);
		return;
	}

	if (piped.kind === 'defer') {
		await disposeDefer(
			job,
			queue,
			deps,
			domain,
			providerKey,
			'self_throttle',
			piped.delayMs,
			piped.reason
		);
		return;
	}
	const eligibilityLease = {
		ip: piped.ctx.ip,
		eligibilityGeneration: piped.ctx.eligibilityGeneration,
	};
	if (!(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
		if (data.routingReentryToken) {
			await handoffRoutingReentry(
				data,
				deps,
				'Selected outbound IP eligibility changed before SMTP'
			);
			return;
		}
		await disposeDefer(
			job,
			queue,
			deps,
			domain,
			providerKey,
			'self_throttle',
			60_000,
			'Selected outbound IP became ineligible before SMTP'
		);
		return;
	}

	const startTime = Date.now();
	try {
		await recordFeedbackProvenance(redis, data);
	} catch (err) {
		logger.warn(
			{ err, messageId: data.messageId },
			'Delayed-feedback provenance unavailable — deferring before SMTP'
		);
		await disposeDefer(
			job,
			queue,
			deps,
			domain,
			providerKey,
			'self_throttle',
			60_000,
			'Delayed-feedback provenance persistence failed'
		);
		return;
	}
	const smtpAttempt = await runJournaledSmtpAttempt({
		redis,
		config,
		jobId: journalJobId,
		job: data,
		attempt: piped.ctx,
		eligibilityLease,
		startedAt: startTime,
	});
	if (smtpAttempt.kind === 'capacity') {
		await disposeDefer(
			job,
			queue,
			deps,
			domain,
			providerKey,
			'self_throttle',
			60_000,
			'SMTP outcome journal is at capacity'
		);
		return;
	}
	if (smtpAttempt.kind === 'effects_applied') return;
	await applyCompletedAttempt(smtpAttempt.journal, job, queue, deps);
}

type CompletedAttemptJournal = Extract<
	Awaited<ReturnType<typeof runJournaledSmtpAttempt>>,
	{ kind: 'completed' }
>['journal'];

/** Apply the exact reduction captured beside the irreversible SMTP result. */
async function applyCompletedAttempt(
	completed: CompletedAttemptJournal,
	job: ReservedJob<EmailJob>,
	queue: Queue<EmailJob>,
	deps: { redis: Redis; config: MtaConfig }
): Promise<void> {
	const { attempt, durationMs, outcome, reduction } = completed.entry;
	const attemptCtx: AttemptCtx = { ...attempt, job: job.data, durationMs };

	await applyEffects(reduction.effects, deps, {
		runSecondary: (effectIdentity, apply) =>
			runSmtpSecondaryEffect(deps.redis, completed.entry, completed.raw, effectIdentity, apply),
	});
	logOutcome(outcome, job.data, attemptCtx);

	if (reduction.defer) {
		// If the first effect pass durably handed off a successor but lost the
		// journal-terminalization response, reconcile that exact successor before
		// re-evaluating message age or jitter on replay.
		if (!(await resumeDeferredHandoff(deps.redis, queue, job.id, job.data))) {
			await disposeDefer(
				job,
				queue,
				deps,
				attempt.domain,
				attempt.destination.providerKey,
				'remote_4xx',
				reduction.defer.delayMs,
				reduction.defer.reason
			);
		}
	} else if (job.data.deliveryDomain === 'member_test') {
		// Test outcomes do not report breaker/warming consumption, so release any
		// authenticated reservation/probe instead of leaving persistent capacity.
		await releaseRoutingReservations(job.data, deps);
	}
	await markSmtpEffectsApplied(deps.redis, completed.entry, completed.raw, {
		now: Date.now(),
	});
}

/**
 * Disposition for a deferred attempt.
 *
 * If the message is still within the max-age window, re-enqueue it onto the
 * same group with the *computed* (jittered) delay — this honours the
 * per-category retry delay (greylist/rate-limit/breaker/warming) that
 * GroupMQ's static backoff would otherwise discard, and crucially does NOT
 * consume a delivery attempt.
 *
 * Past the max age, give up: emit a terminal expired-bounce (delivery log +
 * Convex notification) and let the job complete so it leaves the queue.
 */
async function disposeDefer(
	job: ReservedJob<EmailJob>,
	queue: Queue<EmailJob>,
	deps: { redis: Redis; config: MtaConfig },
	domain: string,
	providerKey: DestinationProviderKey,
	kind: DeferKind,
	delayMs: number,
	reason: string
): Promise<void> {
	const data = job.data;
	const now = Date.now();
	const ageMs = messageAgeMs(job, now);

	if (ageMs >= deps.config.maxMessageAgeMs) {
		await emitExpiredBounce(data, deps, domain, providerKey, ageMs, reason);
		return;
	}

	const delay = withJitter(delayMs);
	const requeued: EmailJob = { ...data, firstEnqueuedAt: data.firstEnqueuedAt ?? job.timestamp };

	await handoffDeferredJob(
		deps.redis,
		queue,
		job.id,
		requeued,
		buildGroupKey(data.ipPool, domain),
		delay
	);

	logger.info(
		{ messageId: data.messageId, to: data.to, domain, kind, delay, reason },
		`Deferred (${kind}) — re-enqueued in ${delay}ms (no attempt consumed)`
	);
}

/**
 * Emit the terminal expired-bounce once the max message age is exceeded.
 * Recorded as a soft bounce (the message kept being transiently deferred) so
 * downstream bounce handling treats it as a give-up rather than a permanent
 * address failure.
 */
async function emitExpiredBounce(
	data: EmailJob,
	deps: { redis: Redis; config: MtaConfig },
	domain: string,
	providerKey: DestinationProviderKey,
	ageMs: number,
	reason: string
): Promise<void> {
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
				message: `Message expired after ${ageMs}ms without delivery: ${reason}`,
				timestamp: Date.now(),
			},
		},
	];

	await applyEffects(effects, deps);
	if (data.deliveryDomain === 'member_test') await releaseRoutingReservations(data, deps);
}

/**
 * Apply the side effects for a pipeline drop. Status-specific:
 *   - `screened`: warn log, Prometheus rejected-counter inc, delivery log.
 *   - `suppressed`: info log, delivery log.
 */
async function handleDrop(
	piped: Extract<PipelineResult<BasePhaseCtx>, { kind: 'drop' }>,
	job: EmailJob,
	domain: string,
	providerKey: DestinationProviderKey,
	deps: { redis: Redis; config: MtaConfig }
): Promise<void> {
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
			message:
				piped.status === 'screened'
					? `Content screening rejected: ${piped.reason}`
					: 'Recipient suppressed by MTA policy',
			errorCode: piped.status === 'screened' ? 'CONTENT_SCREENED' : 'RECIPIENT_SUPPRESSED',
			timestamp: Date.now(),
		},
	});

	await applyEffects(effects, deps);
	if (job.deliveryDomain === 'member_test') await releaseRoutingReservations(job, deps);
}

function buildDropEvent(
	piped: Extract<PipelineResult<BasePhaseCtx>, { kind: 'drop' }>,
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

function logOutcome(outcome: DispatchOutcome, job: EmailJob, ctx: AttemptCtx): void {
	switch (outcome.kind) {
		case 'delivered':
			logger.info(
				{ messageId: job.messageId, to: job.to, ip: ctx.ip, durationMs: ctx.durationMs },
				'Email delivered'
			);
			return;
		case 'hard_bounce':
			logger.warn(
				{
					messageId: job.messageId,
					to: job.to,
					error: outcome.error,
					smtpCode: outcome.smtpCode,
				},
				'Hard bounce — permanent failure'
			);
			return;
		case 'deferred':
			logger.info(
				{
					messageId: job.messageId,
					to: job.to,
					error: outcome.error,
					smtpCode: outcome.smtpCode,
					category: outcome.classification.category,
					suggestedDelay: outcome.classification.suggestedDelayMs,
				},
				`Deferred (${outcome.classification.category}) — will retry`
			);
			return;
		case 'soft_bounce':
			logger.warn(
				{ messageId: job.messageId, to: job.to, error: outcome.error },
				'Soft bounce — connection failure'
			);
			return;
		case 'ambiguous':
			logger.warn(
				{ messageId: job.messageId, to: job.to, error: outcome.error },
				'Ambiguous post-DATA outcome — terminal, not suppressed (message may have been delivered)'
			);
			return;
	}
}
