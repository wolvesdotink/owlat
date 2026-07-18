/**
 * Tier-3 sandboxed worker queue (PP-27).
 *
 * The generalized code-worker (apps/code-worker) polls `queued` `pluginTasks`,
 * runs each job as the unprivileged sandbox uid under the confined-root
 * orchestrator, and reports the outcome back through the internal mutations
 * below. This module is the queue's HOST side: it enforces enqueue authorization
 * (manifest declaration + operator grant of `worker:enqueue` + job-kind
 * ownership + payload bound), the retry ceiling, cancellation semantics, lease
 * reclaim of a crashed worker's jobs, and pluginId-attributed audit on every
 * job's enqueue and terminal outcome.
 *
 * Security posture, all enforced here so an evolving worker cannot regress them:
 *  - A plugin can only ever ENQUEUE, and only its OWN job kinds. Claiming,
 *    cancelling, reclaiming, and reading are host/operator operations.
 *  - Enqueue fails closed: a disabled, ungranted, or undeclared plugin, a
 *    cross-plugin job kind, or an oversized payload inserts nothing.
 *  - Cancellation cannot be escaped: a cancelled queued job is marked cancelled
 *    at claim (never runs); a cancelled running job's next heartbeat tells the
 *    worker to kill it, and a cancelled job is never retried.
 *  - Retries are bounded by the host-clamped `maxAttempts`; a poison job
 *    terminates as `failed` instead of looping forever.
 */

import {
	PLUGIN_WORKER_CAPABILITY,
	PLUGIN_WORKER_PAYLOAD_MAX_BYTES,
	PLUGIN_WORKER_RESULT_MAX_BYTES,
	PLUGIN_WORKER_TIMEOUT_MAX_MS,
	clampWorkerAttempts,
	clampWorkerTimeoutMs,
	isPluginWorkerJobKindOwnedBy,
} from '@owlat/plugin-kit';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation, internalQuery } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId, requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import { recordHostedPluginAudit } from './audit';
import { authorizeSystemBundledPlugin, type HostedPluginActorScope } from './authorization';

/**
 * Default lease window: a `running` row whose heartbeat is older than this is
 * assumed abandoned by a crashed/restarted worker and reclaimed. Set generously
 * beyond the maximum single-execution budget so a slow-but-alive job (which
 * heartbeats while running) is never reclaimed out from under itself.
 */
const DEFAULT_LEASE_MS = PLUGIN_WORKER_TIMEOUT_MAX_MS * 2;

/** Upper bound on rows a single reclaim pass scans — keeps the sweep bounded. */
const RECLAIM_SCAN_LIMIT = 100;

const MAX_ERROR_MESSAGE_CODE_POINTS = 500;

const failReasonValidator = v.union(v.literal('worker_failed'), v.literal('worker_timeout'));

/**
 * Clamp untrusted job text (result / error reason) by BYTE length and strip
 * control characters. Plugin-produced text is untrusted and only ever surfaced
 * on host-owned fields for the UI, never fed to a prompt — so the policy is a
 * byte bound plus control-character stripping, not injection scrubbing.
 */
function clampUntrustedText(text: string, maxBytes: number): string {
	let out = '';
	let bytes = 0;
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		const safe = codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
		const width = Buffer.byteLength(safe);
		if (bytes + width > maxBytes) break;
		out += safe;
		bytes += width;
	}
	return out;
}

function clampErrorMessage(text: string): string {
	const stripped = clampUntrustedText(text, PLUGIN_WORKER_RESULT_MAX_BYTES);
	return stripped.length <= MAX_ERROR_MESSAGE_CODE_POINTS
		? stripped
		: `${[...stripped].slice(0, MAX_ERROR_MESSAGE_CODE_POINTS).join('')}`;
}

/** The row shape the worker needs to run a job; excludes host bookkeeping. */
interface ClaimedJob {
	readonly taskId: Id<'pluginTasks'>;
	readonly pluginId: string;
	readonly jobKind: string;
	readonly payload: string;
	readonly timeoutMs: number;
	readonly attempts: number;
	readonly maxAttempts: number;
}

function claimedJobOf(task: Doc<'pluginTasks'>): ClaimedJob {
	return {
		taskId: task._id,
		pluginId: task.pluginId,
		jobKind: task.jobKind,
		payload: task.payload,
		timeoutMs: task.timeoutMs,
		attempts: task.attempts,
		maxAttempts: task.maxAttempts,
	};
}

function scopeOf(task: Doc<'pluginTasks'>): HostedPluginActorScope {
	return Object.freeze({
		organizationId: task.organizationId,
		userId: 'system:bundled_plugin',
		pluginId: task.pluginId as HostedPluginActorScope['pluginId'],
	});
}

// ============================================================
// Enqueue (host seam — called by plugin backend contributions)
// ============================================================

/**
 * Enqueue a job for the sandboxed worker. An `internalMutation` because only
 * host code (never a public client) may call it; it re-authorizes the plugin in
 * this transaction, so passing a mismatched `pluginId` cannot spoof another
 * plugin's grant, and `jobKind` must be namespaced to the authorized plugin.
 * Returns the new task id, or `null` on any fail-closed denial.
 */
export const enqueue = internalMutation({
	args: {
		pluginId: v.string(),
		jobKind: v.string(),
		payload: v.string(),
		maxAttempts: v.optional(v.number()),
		timeoutMs: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Id<'pluginTasks'> | null> => {
		const scope = await authorizeSystemBundledPlugin(ctx, args.pluginId, PLUGIN_WORKER_CAPABILITY);
		// Disabled / ungranted / undeclared / bad env — nothing is enqueued and no
		// job exists to attribute, so fail closed silently.
		if (!scope) return null;

		// A plugin may only enqueue its OWN, well-formed job kinds. A cross-plugin or
		// malformed kind is a misuse worth attributing to the (authorized) plugin.
		if (!isPluginWorkerJobKindOwnedBy(args.jobKind, scope.pluginId)) {
			await recordHostedPluginAudit(ctx, scope, 'worker.enqueue', 'denied', {
				reasonCode: 'access_denied',
			});
			return null;
		}

		// Untrusted payload is byte-bounded; an oversized payload is rejected rather
		// than truncated (truncation could corrupt a plugin's own framing).
		if (Buffer.byteLength(args.payload) > PLUGIN_WORKER_PAYLOAD_MAX_BYTES) {
			await recordHostedPluginAudit(ctx, scope, 'worker.enqueue', 'denied', {
				reasonCode: 'access_denied',
			});
			return null;
		}

		const now = Date.now();
		const taskId = await ctx.db.insert('pluginTasks', {
			organizationId: scope.organizationId,
			pluginId: scope.pluginId,
			jobKind: args.jobKind,
			payload: args.payload,
			timeoutMs: clampWorkerTimeoutMs(args.timeoutMs),
			status: 'queued',
			attempts: 0,
			maxAttempts: clampWorkerAttempts(args.maxAttempts),
			isCancelRequested: false,
			createdAt: now,
			updatedAt: now,
		});
		await recordHostedPluginAudit(ctx, scope, 'worker.enqueue', 'completed', {});
		return taskId;
	},
});

// ============================================================
// Worker-facing internal functions
// ============================================================

/** Oldest queued job, or null. The worker polls this (admin-key authenticated). */
export const getNextQueued = internalQuery({
	args: {},
	handler: async (ctx): Promise<ClaimedJob | null> => {
		const task = await ctx.db
			.query('pluginTasks')
			.withIndex('by_status', (q) => q.eq('status', 'queued'))
			.order('asc')
			.first();
		return task ? claimedJobOf(task) : null;
	},
});

/**
 * Atomically claim a queued job for execution. A job already cancelled while
 * queued is marked cancelled here (it never runs) and reported as unclaimable.
 */
export const claim = internalMutation({
	args: { taskId: v.id('pluginTasks') },
	handler: async (
		ctx,
		args
	): Promise<{ claimed: false; cancelled?: boolean } | { claimed: true; job: ClaimedJob }> => {
		const task = await ctx.db.get(args.taskId);
		if (!task || task.status !== 'queued') return { claimed: false };

		if (task.isCancelRequested) {
			await ctx.db.patch(task._id, { status: 'cancelled', updatedAt: Date.now() });
			await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'failed', {
				reasonCode: 'worker_cancelled',
				attempts: task.attempts,
			});
			return { claimed: false, cancelled: true };
		}

		const now = Date.now();
		const attempts = task.attempts + 1;
		await ctx.db.patch(task._id, {
			status: 'running',
			attempts,
			claimedAt: now,
			heartbeatAt: now,
			updatedAt: now,
		});
		return { claimed: true, job: { ...claimedJobOf(task), attempts } };
	},
});

/**
 * Refresh a running job's lease and report whether cancellation was requested.
 * The worker calls this on an interval; a `cancelRequested` response is its
 * signal to kill the job's process group and then call `fail`.
 */
export const heartbeat = internalMutation({
	args: { taskId: v.id('pluginTasks') },
	handler: async (ctx, args): Promise<{ alive: boolean; cancelRequested: boolean }> => {
		const task = await ctx.db.get(args.taskId);
		if (!task) return { alive: false, cancelRequested: false };
		if (task.status !== 'running') {
			return { alive: false, cancelRequested: task.isCancelRequested };
		}
		await ctx.db.patch(task._id, { heartbeatAt: Date.now() });
		return { alive: true, cancelRequested: task.isCancelRequested };
	},
});

/** Mark a running job succeeded, storing its clamped, untrusted result. */
export const complete = internalMutation({
	args: { taskId: v.id('pluginTasks'), result: v.optional(v.string()) },
	handler: async (ctx, args): Promise<{ ok: boolean }> => {
		const task = await ctx.db.get(args.taskId);
		if (!task || task.status !== 'running') return { ok: false };
		await ctx.db.patch(task._id, {
			status: 'succeeded',
			result:
				args.result === undefined
					? undefined
					: clampUntrustedText(args.result, PLUGIN_WORKER_RESULT_MAX_BYTES),
			errorMessage: undefined,
			updatedAt: Date.now(),
		});
		await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'completed', {
			attempts: task.attempts,
		});
		return { ok: true };
	},
});

/**
 * Report a running job's failure. Applies the terminal decision:
 *  - cancelled (cancellation cannot be escaped by failing) → `cancelled`;
 *  - attempts remain → requeue for retry (no terminal audit yet);
 *  - attempts exhausted → terminal `failed`.
 */
export const fail = internalMutation({
	args: {
		taskId: v.id('pluginTasks'),
		errorMessage: v.string(),
		reasonCode: v.optional(failReasonValidator),
	},
	handler: async (
		ctx,
		args
	): Promise<{ status: 'cancelled' | 'queued' | 'failed'; retried: boolean }> => {
		const task = await ctx.db.get(args.taskId);
		if (!task || task.status !== 'running') {
			return { status: 'failed', retried: false };
		}
		const errorMessage = clampErrorMessage(args.errorMessage);
		const now = Date.now();

		if (task.isCancelRequested) {
			await ctx.db.patch(task._id, { status: 'cancelled', errorMessage, updatedAt: now });
			await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'failed', {
				reasonCode: 'worker_cancelled',
				attempts: task.attempts,
			});
			return { status: 'cancelled', retried: false };
		}

		if (task.attempts < task.maxAttempts) {
			await ctx.db.patch(task._id, {
				status: 'queued',
				errorMessage,
				claimedAt: undefined,
				heartbeatAt: undefined,
				updatedAt: now,
			});
			return { status: 'queued', retried: true };
		}

		await ctx.db.patch(task._id, { status: 'failed', errorMessage, updatedAt: now });
		await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'failed', {
			reasonCode: args.reasonCode ?? 'worker_failed',
			attempts: task.attempts,
		});
		return { status: 'failed', retried: false };
	},
});

/**
 * Reclaim jobs abandoned by a crashed/restarted worker: a `running` row whose
 * heartbeat predates the lease is failed-with-retry (requeued if attempts
 * remain, else terminal `failed`). Idempotent and bounded.
 *
 * The single code-worker calls this on startup with `leaseMs: 0`: a fresh worker
 * provably holds no running jobs, so on that topology EVERY `running` row is
 * abandoned regardless of how recent its heartbeat is — reclaiming with a lease
 * longer than the max job budget would skip (and permanently strand) a job whose
 * worker crashed and restarted within seconds. `leaseMs` remains parametrized so
 * a future multi-worker or periodic sweep can pass a real lease window.
 */
export const reclaimStale = internalMutation({
	args: { now: v.optional(v.number()), leaseMs: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ reclaimed: number }> => {
		const now = args.now ?? Date.now();
		const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
		const cutoff = now - leaseMs;
		const running = await ctx.db
			.query('pluginTasks')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.order('asc')
			.take(RECLAIM_SCAN_LIMIT);

		let reclaimed = 0;
		for (const task of running) {
			// Never reclaim a job that is still heartbeating (alive but slow).
			if ((task.heartbeatAt ?? task.claimedAt ?? 0) > cutoff) continue;
			reclaimed += 1;
			await reclaimOne(ctx, task, now);
		}
		return { reclaimed };
	},
});

async function reclaimOne(ctx: MutationCtx, task: Doc<'pluginTasks'>, now: number): Promise<void> {
	const errorMessage = 'Worker lease expired; job reclaimed';
	if (task.isCancelRequested) {
		await ctx.db.patch(task._id, { status: 'cancelled', errorMessage, updatedAt: now });
		await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'failed', {
			reasonCode: 'worker_cancelled',
			attempts: task.attempts,
		});
		return;
	}
	if (task.attempts < task.maxAttempts) {
		await ctx.db.patch(task._id, {
			status: 'queued',
			errorMessage,
			claimedAt: undefined,
			heartbeatAt: undefined,
			updatedAt: now,
		});
		return;
	}
	await ctx.db.patch(task._id, { status: 'failed', errorMessage, updatedAt: now });
	await recordHostedPluginAudit(ctx, scopeOf(task), 'worker.run', 'failed', {
		reasonCode: 'worker_failed',
		attempts: task.attempts,
	});
}

// ============================================================
// Operator-facing functions
// ============================================================

/**
 * Request cancellation of a non-terminal job. Only flags intent: a queued job is
 * marked cancelled the moment the worker tries to claim it (so it never runs);
 * a running job is killed by the worker on its next heartbeat. Centralizing the
 * terminal transition in claim/heartbeat keeps the pluginId-attributed audit on
 * the worker-called path and avoids a torn state where the DB says cancelled but
 * a sandbox process is still alive.
 */
export const requestCancel = authedMutation({
	args: { taskId: v.id('pluginTasks') },
	handler: async (ctx, args): Promise<void> => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can cancel plugin jobs'
		);
		const organizationId = await getSingletonOrganizationId(ctx);
		const task = await getOrThrow(ctx, args.taskId, 'Plugin task');
		if (task.organizationId !== organizationId) {
			throwInvalidState('Cannot cancel a job from another organization');
		}
		if (task.status !== 'queued' && task.status !== 'running') {
			throwInvalidState('Cannot cancel a job that has already finished');
		}
		if (task.isCancelRequested) return;
		await ctx.db.patch(task._id, { isCancelRequested: true, updatedAt: Date.now() });
	},
});

/** Recent jobs for this deployment's organization (dashboard/inspection). */
export const listRecent = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args): Promise<Doc<'pluginTasks'>[]> => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view plugin jobs'
		);
		const organizationId = await getSingletonOrganizationId(ctx);
		return await ctx.db
			.query('pluginTasks')
			.withIndex('by_organization', (q) => q.eq('organizationId', organizationId))
			.order('desc')
			.take(args.limit ?? 50);
	},
});
