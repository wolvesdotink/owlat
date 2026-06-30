/**
 * Code Work Tasks
 *
 * Manages tasks for the coding agent: feature request → branch → code → test → PR.
 * Tasks are picked up by the code-worker Docker sidecar service which connects
 * via Convex client SDK to poll for queued tasks.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { assertFeatureEnabled, isFeatureEnabled } from './lib/featureFlags';
import { throwInvalidState, throwNotFound } from './_utils/errors';

// ============================================================
// Queries
// ============================================================

/**
 * Get a task by ID
 */
export const get = authedQuery({
	args: { taskId: v.id('codeWorkTasks') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'inbox.codeTasks');
		return await ctx.db.get(args.taskId);
	},
});

/**
 * List tasks by status
 */
export const listByStatus = authedQuery({
	args: {
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('testing'),
			v.literal('review'),
			v.literal('merged'),
			v.literal('failed')
		),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_status', (q) => q.eq('status', args.status))
			.order('asc')
			.take(args.limit ?? 50);
	},
});

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
 */
export const getNextQueued = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('codeWorkTasks')
			.withIndex('by_status', (q) => q.eq('status', 'queued'))
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
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage code tasks');
		const now = Date.now();
		return await ctx.db.insert('codeWorkTasks', {
			description: args.description,
			inboundMessageId: args.inboundMessageId,
			status: 'queued',
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
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage code tasks');
		const task = await ctx.db.get(args.taskId);
		if (!task) throwNotFound('Task');
		if (task.status === 'merged') throwInvalidState('Cannot cancel a merged task');

		await ctx.db.patch(args.taskId, {
			status: 'failed',
			errorMessage: 'Cancelled by user',
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
 * feature request. Fails safe: when the `inbox.codeTasks` feature flag is off
 * we return without creating anything, and we never create a second task for
 * the same inbound message (idempotent on `inboundMessageId`).
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

		// Build the task description from the inbound subject + body.
		const subject = message.subject?.trim() || '(no subject)';
		const body = (message.textBody ?? message.htmlBody ?? '').trim();
		const description = body ? `${subject}\n\n${body}` : subject;

		const now = Date.now();
		return await ctx.db.insert('codeWorkTasks', {
			description,
			inboundMessageId: args.inboundMessageId,
			status: 'queued',
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Claim a task for processing (code-worker calls this)
 */
export const claim = internalMutation({
	args: { taskId: v.id('codeWorkTasks') },
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (!task || task.status !== 'queued') {
			return { claimed: false };
		}

		await ctx.db.patch(args.taskId, {
			status: 'running',
			updatedAt: Date.now(),
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
 * Mark a task as failed
 */
export const markFailed = internalMutation({
	args: {
		taskId: v.id('codeWorkTasks'),
		errorMessage: v.string(),
		llmCost: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, {
			status: 'failed',
			errorMessage: args.errorMessage,
			llmCost: args.llmCost,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Mark a task as merged (after PR approval)
 */
export const markMerged = internalMutation({
	args: { taskId: v.id('codeWorkTasks') },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, {
			status: 'merged',
			updatedAt: Date.now(),
		});
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
