/**
 * GroupMQ Queue and Worker initialization
 *
 * Sets up the email queue with per-group FIFO processing
 * and configures the worker with the full intelligence pipeline.
 */

import { Queue, Worker } from 'groupmq';
import type Redis from 'ioredis';
import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';
import type { EmailJob } from '../types.js';
import { handleEmailJob } from './handler.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { recordWorkerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS } from '../routes/health.js';
import { QUEUE_NAMESPACE } from './namespace.js';

/** 30 s · 4ⁿ, capped at 2 h, for a handler error the handler did not expect. */
const UNEXPECTED_ERROR_BACKOFF: RetryPolicy = { baseMs: 30_000, factor: 4, capMs: 7_200_000 };

/**
 * The worker's wait before re-running a job whose handler threw. groupmq passes
 * the number of runs that have failed so far (1 after the first), so the first
 * retry waits 2 min, then 8 min, 32 min, and 2 h from then on.
 */
export function unexpectedErrorBackoffMs(attempt: number): number {
	return nextDelay(UNEXPECTED_ERROR_BACKOFF, attempt);
}

/**
 * Stalls a job may survive before GroupMQ dead-letters it.
 *
 * A stall is a job whose worker stopped heartbeating: the process was killed
 * (SIGKILL, OOM, host loss) mid-job. check-stalled.lua re-queues the job until
 * this count is reached, and the re-run resumes from the SMTP outcome journal
 * (journaledSmtpAttempt.ts): a pre-DATA attempt is retried, one cut off after
 * the body is reported ambiguous, a finished one replays its outcome. GroupMQ's
 * default at this worker's concurrency is 1, which dead-lettered every
 * interrupted send on its first stall with no terminal callback, so a single
 * restart lost every in-flight Send. The cap still bounds a job that kills its
 * worker every time it runs.
 */
export const MAX_STALLED_COUNT = 3;

/**
 * Create the email queue
 */
export function createEmailQueue(redis: Redis): Queue<EmailJob> {
	return new Queue<EmailJob>({
		redis,
		namespace: QUEUE_NAMESPACE,
		jobTimeoutMs: 120_000, // 2 min timeout per job (SMTP can be slow)
		maxAttempts: 5,
		keepCompleted: 1000,
		keepFailed: 5000,
	});
}

/**
 * Start the worker liveness heartbeat.
 *
 * Writes one beat immediately and refreshes it every
 * WORKER_HEARTBEAT_INTERVAL_MS for as long as the worker lives. This is
 * deliberately independent of job processing: an install with zero traffic
 * still has a live worker, and /health (plus anything polling it) must say so.
 * The timer is unref'd so it never keeps the process alive on its own.
 *
 * @returns a stop function that clears the timer (call it during shutdown).
 */
export function startWorkerHeartbeat(redis: Redis, serverId: string): () => void {
	const beat = () => {
		recordWorkerHeartbeat(redis, serverId).catch((err) => {
			logger.warn({ err }, 'Worker heartbeat write failed');
		});
	};

	beat();
	const timer = setInterval(beat, WORKER_HEARTBEAT_INTERVAL_MS);
	timer.unref?.();

	return () => clearInterval(timer);
}

/**
 * Create and start the email worker
 */
export function createEmailWorker(
	queue: Queue<EmailJob>,
	redis: Redis,
	config: MtaConfig
): { worker: Worker<EmailJob>; stopHeartbeat: () => void } {
	const worker = new Worker<EmailJob>({
		queue,
		concurrency: config.workerConcurrency,
		handler: async (job) => {
			// The handler owns defer disposition: it re-enqueues deferred jobs
			// onto `queue` with the *computed* per-category delay and resolves
			// normally, so a defer never consumes a delivery attempt. It only
			// throws for genuinely unexpected errors — the backoff below applies
			// to those, governed by the queue's maxAttempts.
			await handleEmailJob(job, queue, redis, config);
		},
		// Exponential backoff for *unexpected* handler errors only (transient
		// deferrals re-enqueue themselves with their own computed delay).
		backoff: unexpectedErrorBackoffMs,
		// The patched cleanup.lua and reserve scripts no longer reclaim expired
		// jobs, so check-stalled.lua is the one recovery path, and this is its bound.
		maxStalledCount: MAX_STALLED_COUNT,
	});

	worker.on('error', (err) => {
		logger.error({ err }, 'Worker error');
	});

	worker.on('failed', (job) => {
		logger.warn({ jobId: job.id, groupId: job.groupId, reason: job.failedReason }, 'Job failed');
	});

	worker.on('stalled', (jobId, groupId) => {
		logger.warn({ jobId, groupId }, 'Job stalled');
	});

	// Heartbeat from creation, not from the first job: a fresh install that has
	// never sent anything must still report worker.alive on /health.
	const stopHeartbeat = startWorkerHeartbeat(redis, config.serverId);

	logger.info({ concurrency: config.workerConcurrency }, 'Email worker created');
	return { worker, stopHeartbeat };
}
