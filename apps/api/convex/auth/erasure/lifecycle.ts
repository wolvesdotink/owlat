/**
 * Member erasure lifecycle — starting an erasure, recovering the subject of a
 * request that predates persisted erasures, restarting stalled or failed jobs,
 * and the operator's view of a request's erasure.
 *
 * A deletion request moves `pending` → `erasing` → `completed`, or to `failed`
 * when the job gives up or its subject cannot be recovered. `pending` is the
 * only state a person can cancel: once `erasing`, data is already gone.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import { internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { components } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { MEMBER_ERASURE_PHASES } from './phaseCatalog';
import { FIRST_MEMBER_ERASURE_PHASE } from './phases';
import { revokeIdentity } from './identityPhases';
import { scheduleDrive } from './schedule';

/** A `running` or `retrying` job untouched this long has lost its chain. */
const STALLED_AFTER_MS = 30 * 60 * 1000;
/** Stalled or failed jobs restarted per sweep, per status. */
const RESTARTS_PER_SWEEP = 50;

export interface ErasureSubject {
	authUserId: string;
	email: string;
}

/** Put a job that gave up back to work, and its request back to `erasing`. */
async function rearm(ctx: MutationCtx, job: Doc<'memberErasureJobs'>, now: number): Promise<void> {
	await ctx.db.patch(job._id, { status: 'running', attempts: 0, updatedAt: now });
	const request = await ctx.db.get(job.requestId);
	if (request && request.status === 'failed') {
		await ctx.db.patch(job.requestId, { status: 'erasing', statusChangedAt: now });
	}
	await scheduleDrive(ctx, job._id);
}

/**
 * Begin (or re-open) the erasure of `subject` for `requestId`, in the caller's
 * transaction. Records the subject on the request, which becomes `erasing` and
 * stops being cancellable; removes the login identity, so existing sessions
 * stop resolving at once; and creates the persisted job with its first step
 * scheduled in this same transaction. Idempotent: a job already under way is
 * left to its chain, a failed one is re-armed.
 */
export async function beginMemberErasure(
	ctx: MutationCtx,
	requestId: Id<'accountDeletionRequests'>,
	subject: ErasureSubject
): Promise<void> {
	const now = Date.now();
	const request = await ctx.db.get(requestId);
	if (!request) return;
	await ctx.db.patch(requestId, {
		status: 'erasing',
		authUserId: subject.authUserId,
		erasureStartedAt: request.erasureStartedAt ?? now,
		statusChangedAt: now,
		lastError: undefined,
	});
	await revokeIdentity(ctx, subject.authUserId);

	const existing = await ctx.db
		.query('memberErasureJobs')
		.withIndex('by_request', (q) => q.eq('requestId', requestId))
		.first();
	if (existing) {
		if (existing.status === 'failed') await rearm(ctx, existing, now);
		return;
	}
	const jobId = await ctx.db.insert('memberErasureJobs', {
		requestId,
		authUserId: subject.authUserId,
		email: subject.email,
		status: 'running',
		phase: FIRST_MEMBER_ERASURE_PHASE,
		rowsProcessed: 0,
		transactions: 0,
		attempts: 0,
		createdAt: now,
		updatedAt: now,
	});
	await scheduleDrive(ctx, jobId);
}

export type SubjectRecovery = { ok: true; authUserId: string } | { ok: false; reason: string };

interface BetterAuthUserRow {
	_id: string;
	email: string;
	createdAt: number;
}

/**
 * Find the subject of a request whose profile is already gone and that never
 * recorded one (it predates persisted erasures: the id only ever lived in a
 * scheduled function's arguments). Conservative on purpose — erasing the wrong
 * person is worse than asking an operator:
 *
 *   - exactly one login identity has the request's address;
 *   - it existed before the request was made, so it is not someone who signed
 *     up with the address afterwards;
 *   - it has no profile and no organization membership, so it is not a live
 *     account.
 */
export async function recoverErasureSubject(
	ctx: MutationCtx,
	request: Doc<'accountDeletionRequests'>
): Promise<SubjectRecovery> {
	if (request.authUserId) return { ok: true, authUserId: request.authUserId };
	const users = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [{ field: 'email', value: request.email.toLowerCase() }],
		paginationOpts: { cursor: null, numItems: 2 },
	})) as { page: BetterAuthUserRow[] };
	if (users.page.length === 0) {
		return { ok: false, reason: 'No login identity has the address any more; subject unknown.' };
	}
	if (users.page.length > 1) {
		return { ok: false, reason: 'Several login identities have the address; subject ambiguous.' };
	}
	const user = users.page[0]!;
	if (user.createdAt > request.requestedAt) {
		return { ok: false, reason: 'The identity with the address was created after the request.' };
	}
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', user._id))
		.first();
	if (profile) return { ok: false, reason: 'The identity with the address has a live profile.' };
	const memberships = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'member',
		where: [{ field: 'userId', value: user._id }],
		paginationOpts: { cursor: null, numItems: 1 },
	})) as { page: unknown[] };
	if (memberships.page.length > 0) {
		return { ok: false, reason: 'The identity with the address is still a member.' };
	}
	return { ok: true, authUserId: user._id };
}

/**
 * A due request whose profile is already gone. Before erasures were persisted,
 * the profile was deleted first and the rest handed to a scheduled chain, and
 * the next daily run treated the missing profile as proof of completion. Now it
 * resumes the erasure when the subject can be recovered, and otherwise marks
 * the request `failed` with the reason. Never `completed`.
 */
export async function resumeRequestWithoutProfile(
	ctx: MutationCtx,
	request: Doc<'accountDeletionRequests'>
): Promise<'resumed' | 'failed'> {
	const recovery = await recoverErasureSubject(ctx, request);
	if (recovery.ok) {
		await beginMemberErasure(ctx, request._id, {
			authUserId: recovery.authUserId,
			email: request.email,
		});
		return 'resumed';
	}
	await ctx.db.patch(request._id, {
		status: 'failed',
		lastError: recovery.reason,
		statusChangedAt: Date.now(),
	});
	return 'failed';
}

/**
 * Re-arm failed jobs and restart chains that went quiet (a crashed action, a
 * lost schedule). Runs from the daily deletion cron, so a job that keeps
 * failing is retried once a day and stays visible as `failed` with its
 * `lastError` in between.
 */
export async function restartStalledMemberErasures(ctx: MutationCtx): Promise<number> {
	const now = Date.now();
	let restarted = 0;
	for (const status of ['running', 'retrying', 'failed'] as const) {
		const stalled = await ctx.db
			.query('memberErasureJobs')
			.withIndex('by_status_and_updated_at', (q) =>
				q.eq('status', status).lt('updatedAt', now - STALLED_AFTER_MS)
			)
			.take(RESTARTS_PER_SWEEP);
		for (const job of stalled) {
			await rearm(ctx, job, now);
			restarted += 1;
		}
	}
	return restarted;
}

/** Operator view: a request's erasure state and progress. */
export const status = internalQuery({
	args: { requestId: v.id('accountDeletionRequests') },
	handler: async (ctx, { requestId }) => {
		const request = await ctx.db.get(requestId);
		if (!request) return null;
		const job = await ctx.db
			.query('memberErasureJobs')
			.withIndex('by_request', (q) => q.eq('requestId', requestId))
			.first();
		return {
			status: request.status,
			erasureStartedAt: request.erasureStartedAt,
			lastError: request.lastError,
			job: job && {
				status: job.status,
				phase: job.phase,
				phaseNumber: MEMBER_ERASURE_PHASES.indexOf(job.phase) + 1,
				phaseCount: MEMBER_ERASURE_PHASES.length,
				rowsProcessed: job.rowsProcessed,
				transactions: job.transactions,
				attempts: job.attempts,
				isWaitingForWorkspaceDeletion: job.isWaitingForWorkspaceDeletion === true,
				lastError: job.lastError,
				lastErrorAt: job.lastErrorAt,
				updatedAt: job.updatedAt,
			},
		};
	},
});

/**
 * Operator retry of a `failed` request: re-arm its job, or try the subject
 * recovery again for a request that never got one.
 */
export const retry = internalMutation({
	args: { requestId: v.id('accountDeletionRequests') },
	handler: async (ctx, { requestId }): Promise<'restarted' | 'resumed' | 'failed' | 'noop'> => {
		const request = await ctx.db.get(requestId);
		if (!request || request.status !== 'failed') return 'noop';
		const job = await ctx.db
			.query('memberErasureJobs')
			.withIndex('by_request', (q) => q.eq('requestId', requestId))
			.first();
		if (job) {
			await rearm(ctx, job, Date.now());
			return 'restarted';
		}
		return await resumeRequestWithoutProfile(ctx, request);
	},
});
