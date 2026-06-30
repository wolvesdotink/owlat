/**
 * Queue Inspection API Routes
 *
 * Master-key protected endpoints for inspecting GroupMQ queue state.
 */

import { Hono } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

const NAMESPACE = 'owlat-mta';

export function createQueueRoutes(queue: Queue<EmailJob>, redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All queue routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /stats — queue depth by state
	app.get('/stats', async (c) => {
		try {
			const stats = await getQueueStats(redis);
			return c.json(stats);
		} catch (err) {
			logger.error({ err }, 'Failed to get queue stats');
			return c.json({ error: 'Failed to get queue stats' }, 500);
		}
	});

	// GET /pending — list pending jobs
	app.get('/pending', async (c) => {
		const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);
		const offset = parseInt(c.req.query('offset') ?? '0', 10);
		const domainFilter = c.req.query('domain');

		try {
			const jobs = await getPendingJobs(redis, limit, offset, domainFilter);
			return c.json({ jobs, limit, offset });
		} catch (err) {
			logger.error({ err }, 'Failed to list pending jobs');
			return c.json({ error: 'Failed to list pending jobs' }, 500);
		}
	});

	// GET /jobs/:jobId — full job details
	app.get('/jobs/:jobId', async (c) => {
		const jobId = c.req.param('jobId');

		try {
			const job = await getJobDetails(redis, jobId);
			if (!job) {
				return c.json({ error: 'Job not found' }, 404);
			}
			return c.json(job);
		} catch (err) {
			logger.error({ err, jobId }, 'Failed to get job details');
			return c.json({ error: 'Failed to get job details' }, 500);
		}
	});

	// DELETE /jobs/:jobId — cancel a specific job
	app.delete('/jobs/:jobId', async (c) => {
		const jobId = c.req.param('jobId');

		try {
			const removed = await cancelJob(redis, jobId);
			return c.json({ success: true, removed });
		} catch (err) {
			logger.error({ err, jobId }, 'Failed to cancel job');
			return c.json({ error: 'Failed to cancel job' }, 500);
		}
	});

	// POST /flush — cancel all pending jobs for an org
	app.post('/flush', async (c) => {
		const orgId = c.req.query('orgId');
		if (!orgId) {
			return c.json({ error: 'orgId query parameter required' }, 400);
		}

		try {
			const count = await flushOrgJobs(redis, orgId);
			return c.json({ success: true, flushed: count });
		} catch (err) {
			logger.error({ err, orgId }, 'Failed to flush org jobs');
			return c.json({ error: 'Failed to flush org jobs' }, 500);
		}
	});

	return app;
}

/**
 * Get queue statistics by scanning GroupMQ Redis structures
 */
async function getQueueStats(redis: Redis): Promise<Record<string, number>> {
	const stats: Record<string, number> = {
		pending: 0,
		active: 0,
		completed: 0,
		failed: 0,
		delayed: 0,
	};

	// Count jobs in different states via GroupMQ key patterns
	const pendingCount = await redis.llen(`${NAMESPACE}:pending`);
	const activeCount = await redis.scard(`${NAMESPACE}:active`);
	const completedCount = await redis.llen(`${NAMESPACE}:completed`);
	const failedCount = await redis.llen(`${NAMESPACE}:failed`);
	const delayedCount = await redis.zcard(`${NAMESPACE}:delayed`);

	stats['pending'] = pendingCount;
	stats['active'] = activeCount;
	stats['completed'] = completedCount;
	stats['failed'] = failedCount;
	stats['delayed'] = delayedCount;

	return stats;
}

/**
 * List pending jobs with optional domain filter
 */
async function getPendingJobs(
	redis: Redis,
	limit: number,
	offset: number,
	domainFilter?: string
): Promise<Array<{ jobId: string; data: EmailJob; createdAt?: string }>> {
	const jobs: Array<{ jobId: string; data: EmailJob; createdAt?: string }> = [];

	// Read pending job IDs
	const jobIds = await redis.lrange(`${NAMESPACE}:pending`, offset, offset + limit * 2 - 1);

	for (const jobId of jobIds) {
		if (jobs.length >= limit) break;

		const jobData = await redis.get(`${NAMESPACE}:job:${jobId}`);
		if (!jobData) continue;

		try {
			const parsed = JSON.parse(jobData);
			const data = parsed.data as EmailJob;

			// Apply domain filter
			if (domainFilter) {
				const toDomain = data.to.split('@')[1]?.toLowerCase();
				if (toDomain !== domainFilter.toLowerCase()) continue;
			}

			jobs.push({
				jobId,
				data,
				createdAt: parsed.createdAt,
			});
		} catch {
			// Skip malformed job data
		}
	}

	return jobs;
}

/**
 * Get full job details including attempt history
 */
async function getJobDetails(
	redis: Redis,
	jobId: string
): Promise<Record<string, unknown> | null> {
	const jobData = await redis.get(`${NAMESPACE}:job:${jobId}`);
	if (!jobData) return null;

	try {
		const parsed = JSON.parse(jobData);

		// Check job state
		const isActive = await redis.sismember(`${NAMESPACE}:active`, jobId);
		const isPending = await redis.lpos(`${NAMESPACE}:pending`, jobId);

		let state = 'unknown';
		if (isActive) state = 'active';
		else if (isPending !== null) state = 'pending';

		return {
			jobId,
			state,
			data: parsed.data,
			createdAt: parsed.createdAt,
			attempts: parsed.attempts ?? 0,
			lastError: parsed.lastError,
			nextRetry: parsed.nextRetry,
		};
	} catch {
		return null;
	}
}

/**
 * Cancel a specific pending job
 */
async function cancelJob(redis: Redis, jobId: string): Promise<boolean> {
	// Remove from pending list
	const removed = await redis.lrem(`${NAMESPACE}:pending`, 1, jobId);
	// Also remove from delayed set
	await redis.zrem(`${NAMESPACE}:delayed`, jobId);
	// Clean up job data
	if (removed > 0) {
		await redis.del(`${NAMESPACE}:job:${jobId}`);
	}
	return removed > 0;
}

/**
 * Flush all pending jobs for a specific organization
 */
async function flushOrgJobs(redis: Redis, orgId: string): Promise<number> {
	let count = 0;
	const jobIds = await redis.lrange(`${NAMESPACE}:pending`, 0, -1);

	for (const jobId of jobIds) {
		const jobData = await redis.get(`${NAMESPACE}:job:${jobId}`);
		if (!jobData) continue;

		try {
			const parsed = JSON.parse(jobData);
			if (parsed.data?.organizationId === orgId) {
				const removed = await redis.lrem(`${NAMESPACE}:pending`, 1, jobId);
				if (removed > 0) {
					await redis.del(`${NAMESPACE}:job:${jobId}`);
					count++;
				}
			}
		} catch {
			// Skip malformed
		}
	}

	return count;
}
