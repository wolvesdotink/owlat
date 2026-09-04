/**
 * GroupMQ Queue and Worker initialization
 *
 * Sets up the email queue with per-group FIFO processing
 * and configures the worker with the full intelligence pipeline.
 */

import { Queue, Worker } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import { handleEmailJob } from './handler.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { recordWorkerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS } from '../routes/health.js';

const QUEUE_NAMESPACE = 'owlat-mta';

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
		// 30s → 2min → 8min → 30min → 2h.
		backoff: (attempt: number) => Math.min(30_000 * Math.pow(4, attempt), 7_200_000),
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
