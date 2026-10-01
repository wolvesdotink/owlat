/**
 * Code Work Tasks
 *
 * Manages tasks for the coding agent: feature request → branch → code → test → PR.
 * Tasks are picked up by the code-worker Docker sidecar service which connects
 * via Convex client SDK to poll for queued tasks.
 */

import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission, requirePermission, hasPermission } from './lib/sessionOrganization';
import { getOrThrow, throwInvalidState } from './_utils/errors';
import { createCodeTaskFromInbound } from './lib/codeTaskInbound';
import {
	CODE_TASK_MAX_ATTEMPTS,
	codeTaskMayRunAgent,
	codeTaskRetryDecision,
} from './lib/codeTaskRetry';
import {
	WORKER_OWNED_STATUSES,
	codeTaskWorkerVerdict,
	type CodeTaskStopReason,
	type CodeTaskWorkerVerdict,
} from './lib/codeTaskFence';

/** Upper bound on rows a single reclaim sweep touches — keeps it bounded. */
const RECLAIM_SCAN_LIMIT = 100;

/** Default / hard ceiling for `listRecent` — bounds inbound-derived text exposure. */
const LIST_RECENT_DEFAULT_LIMIT = 20;
const LIST_RECENT_MAX_LIMIT = 100;

/** What `markFailed` did with the task — the worker logs the retry schedule. */
export type CodeTaskFailureOutcome = {
	status: 'queued' | 'failed';
	retried: boolean;
	attempts: number;
	nextAttemptAt?: number;
	/** Set when the report was not applied, and why (see lib/codeTaskFence). */
	ignored?: CodeTaskStopReason;
};

/**
 * The claim attempt a worker callback belongs to. Optional only because the
 * previous release's worker sends none; its calls still get the status and
 * cancellation checks. N-1 compatibility: make it required after release N+1.
 */
const workerAttemptArg = v.optional(v.number());

/**
 * List recent tasks (for dashboard / verification queue).
 *
 * A task's `description` is inbound-email-derived text (subject + body of a
 * feature request), so this read is gated to the same owner/admin role that may
 * create or cancel tasks — not every authenticated org member — and the caller's
 * `limit` is CLAMPED to a hard ceiling so it can never sweep the whole table.
 */
export const listRecent = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can view code tasks'
		);
		const requested = args.limit ?? LIST_RECENT_DEFAULT_LIMIT;
		// Clamp into [1, MAX]: a non-positive or oversized limit is coerced rather
		// than trusted, so inbound-derived text exposure stays bounded.
		const limit = Math.min(Math.max(Math.floor(requested), 1), LIST_RECENT_MAX_LIMIT);
		return await ctx.db.query('codeWorkTasks').withIndex('by_created_at').order('desc').take(limit);
	},
});

/**
 * Get the next queued task for pickup by the code-worker service.
 *
 * This is an `internalQuery`, not an `authedQuery`: the only caller is the
 * code-worker Docker sidecar, which connects with the deployment admin key
 * (like apps/imap and apps/mail-sync) — it has no user session, so an
 * `authedQuery` floor would reject it. No dashboard surface reads this.
 *
 * A task requeued after a failure carries `nextAttemptAt`; it stays invisible
 * to the worker until that backoff window elapses. `now` is injectable so the
 * schedule can be exercised deterministically in tests.
 *
 * The backoff gate is part of the INDEX RANGE, not a scan-then-filter: the
 * `by_status_and_next_attempt` index orders queued rows by the moment they
 * become claimable, so `lte(nextAttemptAt, now)` names exactly the ready ones
 * and the query reads a single row. A fixed scan window instead used to idle
 * the whole queue whenever the oldest rows were all inside their backoff
 * windows — with enough backing-off tasks ahead of it, a task that was ready
 * right now was never even looked at. A never-attempted row has no
 * `nextAttemptAt` at all, which sorts before every timestamp, so fresh work
 * still comes first and ties break on insertion order (oldest first).
 */
export const getNextQueued = internalQuery({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		return await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_status_and_next_attempt', (q) =>
				q.eq('status', 'queued').lte('nextAttemptAt', now)
			)
			.order('asc')
			.first();
	},
});

// ============================================================
// Mutations (User-facing)
// ============================================================

/**
 * Create a new code work task from a feature request
 */
export const create = authedMutation({
	args: {
		description: v.string(),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage code tasks'
		);
		const now = Date.now();
		return await ctx.db.insert('codeWorkTasks', {
			description: args.description,
			inboundMessageId: args.inboundMessageId,
			status: 'queued',
			attempts: 0,
			maxAttempts: CODE_TASK_MAX_ATTEMPTS,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Cancel a queued or running task
 */
export const cancel = authedMutation({
	args: { taskId: v.id('codeWorkTasks') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage code tasks'
		);
		const task = await getOrThrow(ctx, args.taskId, 'Task');
		if (task.status === 'merged') throwInvalidState('Cannot cancel a merged task');

		// Terminal: clearing the backoff gate keeps a cancelled retry from looking
		// like a task still waiting for its next attempt. `cancelledAt` is what the
		// worker callbacks check, so a run still in flight stops at its next call
		// (lib/codeTaskFence) instead of moving the task on.
		const now = Date.now();
		await ctx.db.patch(args.taskId, {
			status: 'failed',
			errorMessage: 'Cancelled by user',
			nextAttemptAt: undefined,
			cancelledAt: task.cancelledAt ?? now,
			updatedAt: now,
		});
	},
});

// ============================================================
// Internal Mutations (called by code-worker service)
// ============================================================

/**
 * Create a code work task from an inbound feature-request message, behind the
 * feature flag, DMARC, sender-trust and code-agent safety gates. Idempotent on
 * `inboundMessageId`. See `lib/codeTaskInbound.ts`.
 */
export const createFromInbound = internalMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => await createCodeTaskFromInbound(ctx, args.inboundMessageId),
});

/**
 * Claim a task for processing (code-worker calls this).
 *
 * Counts the attempt and re-checks the backoff gate: a poll result can be a
 * moment stale, and a retry must never start before its window has elapsed.
 * A task cancelled while queued is `failed` and is never claimed.
 *
 * The result names the attempt, which the worker sends back on every later
 * call, and whether this claim may run the agent: a reconcile-only grace claim
 * (lib/codeTaskRetry) may only finish an earlier attempt's publication.
 */
export const claim = internalMutation({
	args: { taskId: v.id('codeWorkTasks'), now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		const task = await ctx.db.get(args.taskId);
		if (!task || task.status !== 'queued') {
			return { claimed: false };
		}
		if ((task.nextAttemptAt ?? 0) > now) {
			return { claimed: false };
		}

		const attempt = (task.attempts ?? 0) + 1;
		await ctx.db.patch(args.taskId, {
			status: 'running',
			attempts: attempt,
			nextAttemptAt: undefined,
			updatedAt: now,
		});

		return { claimed: true, attempt, mayRunAgent: codeTaskMayRunAgent(task, attempt) };
	},
});

/**
 * Is this run still the task's live attempt? The worker asks between steps
 * and right before each external effect, and aborts its sandbox children when
 * the answer turns (the user cancelled, or a newer attempt owns the task).
 */
export const checkAttempt = internalQuery({
	args: { taskId: v.id('codeWorkTasks'), attempt: v.number() },
	handler: async (ctx, args): Promise<CodeTaskWorkerVerdict> =>
		codeTaskWorkerVerdict(await ctx.db.get(args.taskId), args.attempt),
});

/**
 * Update task with branch info
 */
export const updateBranch = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		branch: v.string(),
		attempt: workerAttemptArg,
	},
	handler: async (ctx, args): Promise<CodeTaskWorkerVerdict> => {
		const verdict = codeTaskWorkerVerdict(await ctx.db.get(args.taskId), args.attempt);
		if (!verdict.ok) return verdict;
		await ctx.db.patch(args.taskId, {
			branch: args.branch,
			updatedAt: Date.now(),
		});
		return verdict;
	},
});

/**
 * Move task to testing phase
 */
export const markTesting = internalMutation({
	args: { taskId: v.id('codeWorkTasks'), attempt: workerAttemptArg },
	handler: async (ctx, args): Promise<CodeTaskWorkerVerdict> => {
		const verdict = codeTaskWorkerVerdict(await ctx.db.get(args.taskId), args.attempt);
		if (!verdict.ok) return verdict;
		await ctx.db.patch(args.taskId, {
			status: 'testing',
			updatedAt: Date.now(),
		});
		return verdict;
	},
});

/**
 * Record the publication checkpoint right before the worker pushes: the branch,
 * the commit it is about to push and the test output that goes into the PR.
 * Doubles as the last cancellation check before anything leaves the worker. A
 * later attempt that finds the remote branch at this commit resumes publication
 * rather than regenerating (see `publishCommitSha` in schema/codeWork.ts).
 */
export const recordPublication = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		attempt: v.number(),
		branch: v.string(),
		commitSha: v.string(),
		testResults: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<CodeTaskWorkerVerdict> => {
		const verdict = codeTaskWorkerVerdict(await ctx.db.get(args.taskId), args.attempt);
		if (!verdict.ok) return verdict;
		await ctx.db.patch(args.taskId, {
			branch: args.branch,
			publishCommitSha: args.commitSha,
			testResults: args.testResults,
			updatedAt: Date.now(),
		});
		return verdict;
	},
});

/**
 * Complete task with PR URL — moves to review.
 *
 * Idempotent for the attempt that completed it, so the worker can repeat an
 * acknowledgement whose response was lost. A publication that raced the user's
 * cancel keeps the cancelled outcome but records the PR it produced, so the
 * external artifact is accounted for rather than left orphaned.
 */
export const completeWithPR = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		prUrl: v.string(),
		testResults: v.optional(v.string()),
		llmCost: v.optional(v.number()),
		attempt: workerAttemptArg,
	},
	handler: async (ctx, args): Promise<CodeTaskWorkerVerdict> => {
		const task = await ctx.db.get(args.taskId);
		const verdict = codeTaskWorkerVerdict(task, args.attempt);
		if (!verdict.ok) {
			if (verdict.reason === 'cancelled' && args.prUrl && task?.prUrl !== args.prUrl) {
				await ctx.db.patch(args.taskId, { prUrl: args.prUrl, updatedAt: Date.now() });
			}
			const repeated =
				verdict.reason === 'finished' && task?.status === 'review' && task.prUrl === args.prUrl;
			return repeated ? { ok: true } : verdict;
		}
		await ctx.db.patch(args.taskId, {
			status: 'review',
			prUrl: args.prUrl,
			// A resumed publication may carry no output; keep the checkpoint's.
			testResults: args.testResults ?? task?.testResults,
			llmCost: args.llmCost,
			updatedAt: Date.now(),
		});
		return verdict;
	},
});

/**
 * Report a failed run of a task the worker owns.
 *
 * Applies the retry decision: attempts left → requeue behind a backoff window
 * (the worker picks it up again once the window elapses); attempts exhausted →
 * terminal `failed`.
 *
 * `terminal` is the caller's statement that re-running would fail identically.
 * The retry schedule exists for the transient failures (an LLM endpoint hiccup,
 * a network blip, a restarted worker); a deterministic outcome like "the agent
 * produced no changes" is not one of them, and retrying it burns two more full
 * clone/agent/test cycles to reach the same answer. The worker names those
 * explicitly rather than the backend guessing from an error string.
 *
 * Only a `running`/`testing` task of the reporting attempt is touched. A task
 * the user cancelled is already terminal `failed`, and the in-flight run
 * reporting its own failure must never resurrect it into another attempt —
 * cancellation is not escapable by failing, the same rule the Tier-3 plugin
 * queue enforces. Nor may an attempt that a reclaim superseded fail the newer
 * one.
 */
export const markFailed = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		errorMessage: v.string(),
		llmCost: v.optional(v.number()),
		terminal: v.optional(v.boolean()),
		now: v.optional(v.number()),
		attempt: workerAttemptArg,
	},
	handler: async (ctx, args): Promise<CodeTaskFailureOutcome> => {
		const now = args.now ?? Date.now();
		const task = await ctx.db.get(args.taskId);
		const verdict = codeTaskWorkerVerdict(task, args.attempt);
		if (!task || !verdict.ok) {
			const ignored = verdict.ok ? undefined : verdict.reason;
			return { status: 'failed', retried: false, attempts: task?.attempts ?? 0, ignored };
		}

		// Keep a cost already recorded for the task when this report carries none.
		const cost = args.llmCost ?? task.llmCost;
		const decision = args.terminal
			? ({ retry: false, attempts: task.attempts ?? 0 } as const)
			: codeTaskRetryDecision(task, now);

		if (decision.retry) {
			await ctx.db.patch(args.taskId, {
				status: 'queued',
				errorMessage: args.errorMessage,
				llmCost: cost,
				nextAttemptAt: decision.nextAttemptAt,
				updatedAt: now,
			});
			return {
				status: 'queued',
				retried: true,
				attempts: decision.attempts,
				nextAttemptAt: decision.nextAttemptAt,
			};
		}

		await ctx.db.patch(args.taskId, {
			status: 'failed',
			errorMessage: args.errorMessage,
			llmCost: cost,
			nextAttemptAt: undefined,
			updatedAt: now,
		});
		return { status: 'failed', retried: false, attempts: decision.attempts };
	},
});

/**
 * Reclaim tasks abandoned mid-run by a crashed or restarted worker.
 *
 * The code-worker calls this on startup, and again between tasks after a run
 * whose final report never reached the backend. This is a SINGLE-worker deployment
 * (one sidecar drains the queue, one task at a time), so a freshly started
 * process provably owns no task: every `running`/`testing` row is residue of
 * its crashed predecessor (or of its own unacknowledged run: the worker only
 * calls this while it holds no task), whatever its timestamps say — hence no
 * lease window.
 * That premise is not a hope: both compose files pin `code-worker` to
 * `deploy.replicas: 1`, because a second worker starting up would requeue the
 * first one's in-flight task.
 * Each row goes through the same retry decision as a reported failure, so a
 * crash costs an attempt and backs off rather than stranding the task forever.
 */
export const reclaimStale = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ reclaimed: number }> => {
		const now = args.now ?? Date.now();
		const errorMessage = 'Worker restarted mid-run; task reclaimed';

		let reclaimed = 0;
		for (const status of WORKER_OWNED_STATUSES) {
			const stale = await ctx.db
				.query('codeWorkTasks')
				.withIndex('by_status', (q) => q.eq('status', status))
				.order('asc')
				.take(RECLAIM_SCAN_LIMIT);

			for (const task of stale) {
				const decision = codeTaskRetryDecision(task, now);
				await ctx.db.patch(task._id, {
					status: decision.retry ? 'queued' : 'failed',
					errorMessage,
					nextAttemptAt: decision.retry ? decision.nextAttemptAt : undefined,
					updatedAt: now,
				});
				reclaimed += 1;
			}
		}
		return { reclaimed };
	},
});

/**
 * Resolve a task by its PR URL and mark it merged.
 *
 * Called by the GitHub merge webhook (`webhooks/githubHttp.ts`) after the
 * `pull_request` `closed`+merged event is verified. Returns the resolved task
 * id, or `null` when no task tracks that PR (the webhook acknowledges either
 * way — a PR we don't track is not an error).
 */
export const markMergedByPrUrl = internalMutation({
	args: { prUrl: v.string() },
	handler: async (ctx, args) => {
		const task = await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_pr_url', (q) => q.eq('prUrl', args.prUrl))
			.first();
		if (!task) {
			return null;
		}
		if (task.status !== 'merged') {
			await ctx.db.patch(task._id, {
				status: 'merged',
				updatedAt: Date.now(),
			});
		}
		return task._id;
	},
});
