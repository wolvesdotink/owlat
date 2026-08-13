/**
 * Code Work Tasks
 *
 * Manages tasks for the coding agent: feature request → branch → code → test → PR.
 * Tasks are picked up by the code-worker Docker sidecar service which connects
 * via Convex client SDK to poll for queued tasks.
 */

import { v } from 'convex/values';
import { openInboundMessageBody } from './lib/messageBody';
import { normalizeEmail } from '@owlat/shared';
import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { isFeatureEnabled } from './lib/featureFlags';
import { getOrThrow, throwInvalidState } from './_utils/errors';
import { extractEmail } from './lib/emailAddress';
import { checkCodeAgentSafety } from './lib/codeAgentGuard';
import { CODE_TASK_MAX_ATTEMPTS, codeTaskRetryDecision } from './lib/codeTaskRetry';

/**
 * Rows a single `getNextQueued` poll inspects. Queued tasks are ordered oldest
 * first, but a retry waits behind its backoff gate, so the head of the queue is
 * not always claimable — the window lets the worker look past a handful of
 * backing-off rows without an unbounded scan.
 */
const QUEUE_SCAN_LIMIT = 25;

/** Upper bound on rows a single reclaim sweep touches — keeps it bounded. */
const RECLAIM_SCAN_LIMIT = 100;

/** Statuses in which the code-worker (not the user) owns the task. */
const WORKER_OWNED_STATUSES = ['running', 'testing'] as const;

type CodeTaskStatus = Doc<'codeWorkTasks'>['status'];

function isWorkerOwned(status: CodeTaskStatus): boolean {
	return (WORKER_OWNED_STATUSES as readonly CodeTaskStatus[]).includes(status);
}

/** What `markFailed` did with the task — the worker logs the retry schedule. */
export type CodeTaskFailureOutcome = {
	status: 'queued' | 'failed';
	retried: boolean;
	attempts: number;
	nextAttemptAt?: number;
};

/**
 * Is the inbound sender a trusted org member?
 *
 * A code-work task hands an attacker-controllable email body to an autonomous
 * coding agent, so ONLY mail from an org member (a real, provisioned account on
 * this single-org instance) may spawn one. Membership is resolved from
 * `userProfiles` — the org member table — matched on the normalized sender
 * address. The table is small (one org per deployment), so a bounded scan is
 * both cheap and casing-robust regardless of how BetterAuth stored the address.
 * Soft-deleted profiles are excluded.
 */
async function isTrustedInboundSender(ctx: MutationCtx, fromField: string): Promise<boolean> {
	const sender = extractEmail(fromField);
	if (!sender) return false;

	// Fast path: exact match on the by_email index (emails commonly stored
	// lowercased). Falls through to a bounded normalized scan otherwise.
	const exact = await ctx.db
		.query('userProfiles')
		.withIndex('by_email', (q) => q.eq('email', sender))
		.first();
	if (exact && !exact.deletedAt) return true;

	const profiles = await ctx.db.query('userProfiles').take(1000);
	return profiles.some((p) => !p.deletedAt && normalizeEmail(p.email) === sender);
}

/**
 * List recent tasks (for dashboard / verification queue)
 */
export const listRecent = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_created_at')
			.order('desc')
			.take(args.limit ?? 20);
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
 */
export const getNextQueued = internalQuery({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		const queued = await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_status', (q) => q.eq('status', 'queued'))
			.order('asc')
			.take(QUEUE_SCAN_LIMIT);
		return queued.find((task) => (task.nextAttemptAt ?? 0) <= now) ?? null;
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
		// like a task still waiting for its next attempt.
		await ctx.db.patch(args.taskId, {
			status: 'failed',
			errorMessage: 'Cancelled by user',
			nextAttemptAt: undefined,
			updatedAt: Date.now(),
		});
	},
});

// ============================================================
// Internal Mutations (called by code-worker service)
// ============================================================

/**
 * Create a code work task from an inbound feature-request message.
 *
 * Called by the inbox processing lifecycle when a message is classified as a
 * feature request. Fails safe on several fronts before anything reaches the
 * coding agent:
 *   - the `inbox.codeTasks` feature flag must be on (off by default);
 *   - the sender must be a trusted org member — an untrusted sender's mail
 *     still processes as normal inbound, it simply does NOT spawn a code task
 *     (a stranger cannot direct the coding agent by emailing the inbox). This
 *     keys on the (verbatim-stored) "From" address, so it assumes upstream
 *     inbound-sender authentication (DMARC/DKIM alignment); a spoofed member
 *     address would pass the allowlist, leaving the guard below as the backstop;
 *   - a code-agent-specific appropriateness check must pass — instructions
 *     smuggled to a CODE agent ("add a backdoor", "leak the env secrets",
 *     "force-push to main") are distinct from the email-assistant injection
 *     the upstream `security_scan` step guards, so they get their own gate.
 * We never create a second task for the same inbound message (idempotent on
 * `inboundMessageId`).
 */
export const createFromInbound = internalMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		// Feature gate — boolean check (internal mutation, no throwing).
		if (!(await isFeatureEnabled(ctx, 'inbox.codeTasks'))) {
			return null;
		}

		// Idempotency: never spawn a second task for the same inbound message.
		const existing = await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_inbound', (q) => q.eq('inboundMessageId', args.inboundMessageId))
			.first();
		if (existing) {
			return existing._id;
		}

		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) {
			return null;
		}

		// Trust gate: only org members may spawn code-work tasks. Untrusted
		// senders are processed as normal inbound (already done upstream); they
		// just don't reach the coding agent.
		if (!(await isTrustedInboundSender(ctx, message.from))) {
			return null;
		}

		// Code-agent appropriateness check — distinct from the email-assistant
		// injection guard. Rejects destructive / exfiltrating / backdoor
		// instructions before a task is ever queued.
		const { text: bodyText, html: bodyHtml } = await openInboundMessageBody(message);
		const safety = checkCodeAgentSafety({
			subject: message.subject ?? '',
			textBody: bodyText,
			htmlBody: bodyHtml,
		});
		if (!safety.safe) {
			return null;
		}

		// Build the task description from the inbound subject + body.
		const subject = message.subject?.trim() || '(no subject)';
		const body = (bodyText ?? bodyHtml ?? '').trim();
		const description = body ? `${subject}\n\n${body}` : subject;

		const now = Date.now();
		return await ctx.db.insert('codeWorkTasks', {
			description,
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
 * Claim a task for processing (code-worker calls this).
 *
 * Counts the attempt and re-checks the backoff gate: a poll result can be a
 * moment stale, and a retry must never start before its window has elapsed.
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

		await ctx.db.patch(args.taskId, {
			status: 'running',
			attempts: (task.attempts ?? 0) + 1,
			nextAttemptAt: undefined,
			updatedAt: now,
		});

		return { claimed: true };
	},
});

/**
 * Update task with branch info
 */
export const updateBranch = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		branch: v.string(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, {
			branch: args.branch,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Move task to testing phase
 */
export const markTesting = internalMutation({
	args: { taskId: v.id('codeWorkTasks') },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, {
			status: 'testing',
			updatedAt: Date.now(),
		});
	},
});

/**
 * Complete task with PR URL — moves to review
 */
export const completeWithPR = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		prUrl: v.string(),
		testResults: v.optional(v.string()),
		llmCost: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, {
			status: 'review',
			prUrl: args.prUrl,
			testResults: args.testResults,
			llmCost: args.llmCost,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Report a failed run of a task the worker owns.
 *
 * Applies the retry decision: attempts left → requeue behind a backoff window
 * (the worker picks it up again once the window elapses); attempts exhausted →
 * terminal `failed`.
 *
 * Only a `running`/`testing` task is touched. A task the user cancelled is
 * already terminal `failed`, and the in-flight run reporting its own failure
 * must never resurrect it into another attempt — cancellation is not escapable
 * by failing, the same rule the Tier-3 plugin queue enforces.
 */
export const markFailed = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		errorMessage: v.string(),
		llmCost: v.optional(v.number()),
		now: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<CodeTaskFailureOutcome> => {
		const now = args.now ?? Date.now();
		const task = await ctx.db.get(args.taskId);
		if (!task || !isWorkerOwned(task.status)) {
			return { status: 'failed', retried: false, attempts: task?.attempts ?? 0 };
		}

		// Keep a cost already recorded for the task when this report carries none.
		const cost = args.llmCost ?? task.llmCost;
		const decision = codeTaskRetryDecision(task, now);

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
 * The code-worker calls this on startup. This is a SINGLE-worker deployment
 * (one sidecar drains the queue, one task at a time), so a freshly started
 * process provably owns no task: every `running`/`testing` row is residue of
 * its crashed predecessor, whatever its timestamps say — hence no lease window.
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
