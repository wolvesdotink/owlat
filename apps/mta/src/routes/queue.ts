/**
 * Queue Inspection API Routes
 *
 * Master-key protected endpoints for inspecting GroupMQ queue state.
 *
 * WHY THIS FILE IS WRITTEN AGAINST THE QUEUE OBJECT AND NOT AGAINST REDIS
 *
 * Until now every handler here read raw Redis keys it had invented: a
 * `:pending` LIST, an `:active` SET, `LLEN` on the `:completed`/`:failed`
 * ZSETs, `GET` on the `:job:<id>` hash — under a `owlat-mta:` prefix that
 * GroupMQ never writes to, because it namespaces its own keys `groupmq:<name>`.
 * None of those structures exists. So `/stats` answered all zeros, `/pending`
 * answered an empty list, `/jobs/:id` answered 404, and the delete paths
 * answered "nothing removed" — on a queue that at one point held 6,037,170
 * delayed entries. The endpoints were not wrong about the numbers; they were
 * reading a queue that does not exist, and reporting its emptiness confidently.
 *
 * A route layer that restates the queue's internal schema can drift from it
 * silently, and did, for the entire life of the file. So the schema is no
 * longer restated: every read goes through GroupMQ's own public API on the
 * `Queue` instance, which is the only thing that can be wrong at the same time
 * as the queue itself. The one remaining raw-key reader, `probeDelayedQueue`,
 * derives its prefix from `QUEUE_NAMESPACE` for the same reason.
 *
 * NO `/flush`. The old `POST /flush?orgId=` claimed to cancel an
 * organization's pending mail. GroupMQ groups jobs by `{ipPool}:{domain}` —
 * there is no organization dimension in the queue and no bulk remove — so the
 * only possible implementation is "read every waiting job id, fetch every
 * payload, delete the matches", which is unbounded work on exactly the runaway
 * backlog an operator would reach for it during, and which destroys deliverable
 * mail from a single unconfirmed HTTP call. It has never once removed a job, so
 * nothing is lost by deleting it, and `DELETE /jobs/:jobId` covers the targeted
 * case with the state checks below. Do not reintroduce it without a queue-side
 * index and a dry-run.
 */

import { Hono } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { probeDelayedQueue } from '../queue/delayedOrphans.js';

/**
 * Ceiling on `/pending?limit=`. GroupMQ's own `getJobsByStatus` scan is capped
 * at 500 ids internally, and this endpoint exists to let an operator eyeball
 * the head of the queue, not to export it.
 */
export const PENDING_LIMIT_MAX = 200;
/** `/pending?limit=` when the caller does not say. */
export const PENDING_LIMIT_DEFAULT = 50;

/** A queued job as `/pending` reports it. */
interface QueuedJobSummary {
	jobId: string;
	/** GroupMQ group — `{ipPool}:{recipientDomain}`, the FIFO unit. */
	groupId: string;
	messageId: string | null;
	to: string | null;
	from: string | null;
	organizationId: string | null;
	ipPool: string | null;
	/** When GroupMQ first accepted this job, ms since epoch. */
	enqueuedAt: number;
	attempts: number;
	maxAttempts: number;
}

/**
 * The payload fields an operator needs to identify a message, and no more.
 *
 * The body (`html`, `text`, `sealedMimeBase64`, attachment bytes) is
 * deliberately not returned: this is a queue inspector, not a mail reader, and
 * a listing endpoint that streams 50 customers' message bodies through an admin
 * HTTP response is a disclosure with no operational use. Sizes are reported so
 * "why is this job 12 MB" is still answerable.
 */
function summarizeJob(job: {
	id: string;
	groupId: string;
	data: EmailJob;
	timestamp: number;
	attemptsMade: number;
	opts: { attempts: number };
}): QueuedJobSummary {
	// GroupMQ hands back `null` data for a job whose hash lost its payload.
	const data = job.data as EmailJob | null;
	return {
		jobId: job.id,
		groupId: job.groupId,
		messageId: data?.messageId ?? null,
		to: data?.to ?? null,
		from: data?.from ?? null,
		organizationId: data?.organizationId ?? null,
		ipPool: data?.ipPool ?? null,
		enqueuedAt: job.timestamp,
		attempts: job.attemptsMade,
		maxAttempts: job.opts.attempts,
	};
}

/** Recipient domain of a summarized job, lowercased, or null. */
function recipientDomain(summary: QueuedJobSummary): string | null {
	return summary.to?.split('@')[1]?.toLowerCase() ?? null;
}

/** A query parameter read as a positive integer, or the fallback. */
function positiveIntParam(raw: string | undefined, fallback: number, max: number): number {
	const parsed = Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, max);
}

/**
 * GroupMQ's `getJob` rejects rather than resolving null when the job hash is
 * gone. Match its message exactly: anything else — a dropped Redis connection,
 * a NOSCRIPT — must stay a 500 rather than be flattened into "no such job",
 * which is the class of confident wrong answer this file is being repaired for.
 */
function isJobNotFound(err: unknown, jobId: string): boolean {
	return err instanceof Error && err.message === `Job ${jobId} not found`;
}

export function createQueueRoutes(queue: Queue<EmailJob>, redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All queue routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /stats — queue depth by state
	app.get('/stats', async (c) => {
		try {
			const [counts, groups, delayProbe] = await Promise.all([
				queue.getJobCounts(),
				queue.getUniqueGroupsCount(),
				probeDelayedQueue(redis),
			]);

			return c.json({
				/**
				 * Jobs held in a group, i.e. not yet taken by a worker. GroupMQ
				 * keeps a delayed job in its group as well as in the delay set,
				 * so `delayed` is a SUBSET of this and the two do not sum:
				 * `waiting - delayed` is what a worker could pick up right now.
				 */
				waiting: counts.waiting,
				/** Jobs reserved by a worker right now. */
				active: counts.active,
				/** Waiting jobs serving a delay before their next attempt. */
				delayed: counts.delayed,
				/**
				 * Retained terminal jobs — bounded by the queue's `keepCompleted`
				 * / `keepFailed`, so these are retention-window sizes and not
				 * lifetime totals. Lifetime delivery outcomes live in
				 * `/delivery-logs`.
				 */
				completed: counts.completed,
				failed: counts.failed,
				/** Distinct `{ipPool}:{domain}` groups holding at least one job. */
				groups,
				/**
				 * The same delay-set integrity verdict `/health` reports, minus
				 * its `delayed` count — that number is already above, and one
				 * payload carrying two independently-read copies of it is how
				 * two sources start disagreeing.
				 */
				delayedQueue: {
					status: delayProbe.status,
					overdue: delayProbe.overdue,
					sampled: delayProbe.sampled,
					orphaned: delayProbe.orphaned,
				},
			});
		} catch (err) {
			logger.error({ err }, 'Failed to get queue stats');
			return c.json({ error: 'Failed to get queue stats' }, 500);
		}
	});

	// GET /pending — head of the queue
	//
	// "Pending" is every job held in a group and not yet taken by a worker,
	// which includes jobs still serving a retry delay: GroupMQ's waiting scan
	// reads the group ZSETs and cannot tell the two apart without a per-job
	// lookup. No per-job `state` is claimed here for that reason — ask
	// `/jobs/:jobId`, which resolves it properly.
	//
	// A bounded sample, not a page. GroupMQ scans a capped number of ids per
	// call and orders them only best-effort, so an `offset` past that cap would
	// return an empty array that reads exactly like "no more jobs" — the old
	// endpoint's failure mode, re-earned. `offset` is therefore gone; `waiting`
	// and `sampled` are returned so a caller can always tell how much of the
	// queue it just saw.
	app.get('/pending', async (c) => {
		const limit = positiveIntParam(c.req.query('limit'), PENDING_LIMIT_DEFAULT, PENDING_LIMIT_MAX);
		const domainFilter = c.req.query('domain')?.toLowerCase();

		try {
			const [sample, waiting] = await Promise.all([
				queue.getJobsByStatus(['waiting'], 0, limit - 1),
				queue.getWaitingCount(),
			]);

			const summaries = sample.map(summarizeJob);
			const jobs = domainFilter
				? summaries.filter((job) => recipientDomain(job) === domainFilter)
				: summaries;

			return c.json({
				jobs,
				limit,
				/** Waiting jobs this scan actually looked at, before filtering. */
				sampled: sample.length,
				/** Waiting jobs in the whole queue. */
				waiting,
				domain: domainFilter ?? null,
			});
		} catch (err) {
			logger.error({ err }, 'Failed to list pending jobs');
			return c.json({ error: 'Failed to list pending jobs' }, 500);
		}
	});

	// GET /jobs/:jobId — one job's state and attempt history
	app.get('/jobs/:jobId', async (c) => {
		const jobId = c.req.param('jobId');

		try {
			const job = await queue.getJob(jobId);
			const data = job.data as EmailJob | null;

			return c.json({
				...summarizeJob(job),
				/**
				 * Resolved per job against the delay and processing sets, so
				 * unlike the `/pending` listing this distinguishes a job a
				 * worker could take now from one still serving a delay.
				 */
				state: job.status,
				dkimDomain: data?.dkimDomain ?? null,
				/** First enqueue of the whole defer chain, not of this attempt. */
				firstEnqueuedAt: data?.firstEnqueuedAt ?? null,
				/** Body sizes only — see `summarizeJob` on why not the body. */
				bytes: {
					html: data?.html?.length ?? 0,
					text: data?.text?.length ?? 0,
					sealedMime: data?.sealedMimeBase64?.length ?? 0,
					attachments: data?.attachments?.length ?? 0,
				},
				processedOn: job.processedOn ?? null,
				finishedOn: job.finishedOn ?? null,
				/** Remaining wait, ms, for a job on the retry ladder. */
				delayMs: job.opts.delay ?? null,
				lastError: job.failedReason || null,
			});
		} catch (err) {
			if (isJobNotFound(err, jobId)) return c.json({ error: 'Job not found' }, 404);
			logger.error({ err, jobId }, 'Failed to get job details');
			return c.json({ error: 'Failed to get job details' }, 500);
		}
	});

	// DELETE /jobs/:jobId — destroy one queued message
	//
	// This endpoint did nothing for its entire existence; it does something now,
	// and what it does is delete mail that would otherwise have been delivered.
	// Two guards make that survivable:
	//
	//  - A job a worker has already reserved is refused. GroupMQ's `remove`
	//    happily tears an id out of `:processing`, but the SMTP conversation it
	//    names is in flight in another process and will not stop. Removing it
	//    does not cancel a delivery, it only destroys the bookkeeping that would
	//    have recorded one — and, worse, strands the job id in the per-group
	//    `:active` list that `reserve` gates on, wedging that recipient domain
	//    forever. So the answer is 409 and "wait for it to settle", which for a
	//    deferred job is one retry rung away. THE REFUSAL IS DECIDED INSIDE
	//    `remove.lua` (see `patches/groupmq@1.1.0.patch`): a read here followed
	//    by a remove there is a race an operator loses on exactly the
	//    head-of-group job they reach for. The read below is a fast path and a
	//    source of log identity, not the guard.
	//  - Every removal is logged with the identity of what was destroyed, so
	//    "where did that message go" has an answer that is not "nowhere".
	app.delete('/jobs/:jobId', async (c) => {
		const jobId = c.req.param('jobId');

		try {
			const job = await queue.getJob(jobId);
			if (job.status === 'active') {
				return c.json(
					{
						error: 'Job is being delivered and cannot be removed',
						jobId,
						state: job.status,
					},
					409
				);
			}

			const summary = summarizeJob(job);
			const removed = await queue.remove(jobId);
			if (!removed) {
				// `remove` collapses three different things into `false`: the job
				// was gone, the patched script refused it because a worker
				// reserved it since the read above, or the call itself blew up —
				// GroupMQ catches Redis errors in `remove` and returns `false`
				// too. Answering 404 to all three would tell an operator a
				// message does not exist while it is queued and about to be
				// delivered, which is the class of confident wrong answer this
				// file exists to stop. Re-read to find out which it was: a job
				// that is gone throws `not found` into the catch below and 404s,
				// and anything else means the job is still in the queue.
				const survivor = await queue.getJob(jobId);
				if (survivor.status === 'active') {
					return c.json(
						{
							error: 'Job is being delivered and cannot be removed',
							jobId,
							state: survivor.status,
						},
						409
					);
				}
				logger.error(
					{ jobId, state: survivor.status },
					'Queue reported no removal but the job is still queued'
				);
				return c.json({ error: 'Failed to remove job' }, 500);
			}

			logger.warn(
				{
					jobId,
					groupId: summary.groupId,
					state: job.status,
					messageId: summary.messageId,
					organizationId: summary.organizationId,
					attempts: summary.attempts,
				},
				'Queued message removed by operator request'
			);

			return c.json({ removed: true, jobId, state: job.status });
		} catch (err) {
			if (isJobNotFound(err, jobId)) return c.json({ error: 'Job not found' }, 404);
			logger.error({ err, jobId }, 'Failed to remove job');
			return c.json({ error: 'Failed to remove job' }, 500);
		}
	});

	return app;
}
