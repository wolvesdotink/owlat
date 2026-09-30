/**
 * Audience count job (module) — the resumable exact count behind the campaign
 * wizard's recipient readout (#916).
 *
 * The subscribed `countRecipients` query only ever reads one budgeted page. An
 * audience bigger than that is counted here: `request` opens (or reuses) the
 * `audienceCountJobs` row for the audience's current definition, and
 * `step` walks the audience one recipient page per execution with the send
 * walker's own resolver (`resolveRecipientPageImpl`), so every execution has the
 * page resolver's fixed query and document budget and the finished count equals
 * what a send would resolve.
 *
 * CONCURRENCY AND FRESHNESS
 *  - Coalescing: identical requests share one row (keyed by definition); a
 *    request while the row is counting, or complete and younger than
 *    `AUDIENCE_COUNT_MAX_AGE_MS`, changes nothing.
 *  - Edits: the key covers the topic's DOI flag and the segment's filters. A
 *    step re-derives the key before reading its page and abandons the row when
 *    the definition moved, and the readout looks rows up by the CURRENT key, so
 *    a result for an old definition is never shown as current.
 *  - Restarts bump `generation`; a step scheduled by an older run exits.
 *  - Not a snapshot: each contact is judged once, by the step that reads its
 *    page. Contacts or suppressions that change behind the cursor are not
 *    reflected until the next count. See the `audienceCountJobs` table comment.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { campaignsMutation } from './_helpers';
import { audienceValidator, type StoredAudience } from './audience';
import { COUNT_PAGE_SIZE, resolveRecipientPageImpl } from './audienceResolution';
import {
	audienceCountTarget,
	isAudienceCountJobCurrent,
	jobCountsTarget,
	type AudienceCountTarget,
} from './audienceCountState';

/** Rows of superseded definitions dropped per request (older filter versions). */
const SUPERSEDED_CLEANUP_LIMIT = 16;

/** The identity fields a new or restarted job row starts from. */
export async function planAudienceCountJob(
	ctx: QueryCtx,
	audience: StoredAudience
): Promise<{
	target: AudienceCountTarget;
	fields: Pick<
		Doc<'audienceCountJobs'>,
		'audienceKey' | 'audienceRef' | 'audience' | 'resolvedAudience'
	>;
} | null> {
	const target = await audienceCountTarget(ctx, audience);
	if (target === null) return null;
	return {
		target,
		fields: {
			audienceKey: target.key,
			audienceRef: target.ref,
			audience,
			resolvedAudience: target.audience,
		},
	};
}

export type AudienceCountStepOutcome =
	| { kind: 'abandoned' }
	| {
			kind: 'progress' | 'complete';
			patch: Pick<Doc<'audienceCountJobs'>, 'cursor' | 'total' | 'eligible' | 'pages' | 'status'>;
	  };

/**
 * One step of a job: confirm the definition has not moved, resolve ONE page at
 * the row's cursor, and return the new running totals. Pure over `ctx.db`
 * reads (the mutation applies the patch), so the cost probe and tests drive it
 * over an instrumented reader.
 */
export async function advanceAudienceCount(
	ctx: QueryCtx,
	job: Pick<
		Doc<'audienceCountJobs'>,
		'audienceKey' | 'audience' | 'resolvedAudience' | 'cursor' | 'total' | 'eligible' | 'pages'
	>
): Promise<AudienceCountStepOutcome> {
	const target = await audienceCountTarget(ctx, job.audience);
	if (target === null || !jobCountsTarget(job, target)) {
		return { kind: 'abandoned' };
	}
	const page = await resolveRecipientPageImpl(ctx, {
		audience: job.resolvedAudience,
		cursor: job.cursor,
		numItems: COUNT_PAGE_SIZE,
	});
	const done = page.nextCursor === null;
	return {
		kind: done ? 'complete' : 'progress',
		patch: {
			cursor: page.nextCursor ?? job.cursor,
			total: job.total + page.pageCandidates,
			eligible: job.eligible + page.recipients.length,
			pages: job.pages + 1,
			status: done ? 'complete' : 'counting',
		},
	};
}

/**
 * Ask for an exact count of `audience`. Idempotent and coalescing: returns
 * without scheduling anything while the definition's row is counting or holds
 * a result younger than the refresh window. Otherwise (re)starts the row and
 * schedules its first step.
 */
// all-members: the result is the number any member already reads through
// `countRecipients` (same floor); the job only spreads those reads over bounded
// executions and writes nothing but its own derived count row.
export const request = campaignsMutation({
	args: { audience: audienceValidator },
	handler: async (ctx, { audience }): Promise<{ status: 'started' | 'current' | 'nothing' }> => {
		const planned = await planAudienceCountJob(ctx, audience);
		if (planned === null) return { status: 'nothing' };
		const now = Date.now();
		const existing = await ctx.db
			.query('audienceCountJobs')
			.withIndex('by_audience_key', (q) => q.eq('audienceKey', planned.target.key))
			.first();
		if (existing && jobCountsTarget(existing, planned.target)) {
			if (isAudienceCountJobCurrent(existing, now)) return { status: 'current' };
		}

		const fresh = {
			...planned.fields,
			status: 'counting' as const,
			cursor: '',
			total: 0,
			eligible: 0,
			pages: 0,
			startedAt: now,
			updatedAt: now,
		};
		let jobId;
		let generation;
		if (existing) {
			generation = existing.generation + 1;
			jobId = existing._id;
			await ctx.db.patch(jobId, { ...fresh, generation, completedAt: undefined });
		} else {
			generation = 1;
			jobId = await ctx.db.insert('audienceCountJobs', { ...fresh, generation });
		}

		// Drop rows for older definitions of the same topic/segment, so edits do
		// not accumulate rows. A row another open view may still be showing (a
		// send-time snapshot next to the live filters) is left until it ages out.
		// Bounded; anything left goes on a later request.
		const siblings = await ctx.db
			.query('audienceCountJobs')
			.withIndex('by_audience_ref', (q) => q.eq('audienceRef', planned.target.ref))
			.take(SUPERSEDED_CLEANUP_LIMIT);
		for (const sibling of siblings) {
			if (
				sibling._id !== jobId &&
				sibling.audienceKey !== planned.target.key &&
				!isAudienceCountJobCurrent(sibling, now)
			) {
				await ctx.db.delete(sibling._id);
			}
		}

		await ctx.scheduler.runAfter(0, internal.campaigns.audienceCountJob.step, {
			jobId,
			generation,
		});
		return { status: 'started' };
	},
});

/** One bounded step of a job; reschedules itself until the audience is exhausted. */
export const step = internalMutation({
	args: { jobId: v.id('audienceCountJobs'), generation: v.number() },
	handler: async (ctx, { jobId, generation }) => {
		const job = await ctx.db.get(jobId);
		if (!job || job.generation !== generation || job.status !== 'counting') return;
		const outcome = await advanceAudienceCount(ctx, job);
		const now = Date.now();
		if (outcome.kind === 'abandoned') {
			await ctx.db.patch(jobId, { status: 'abandoned', updatedAt: now });
			return;
		}
		await ctx.db.patch(jobId, {
			...outcome.patch,
			updatedAt: now,
			...(outcome.kind === 'complete' ? { completedAt: now } : {}),
		});
		if (outcome.kind === 'progress') {
			await ctx.scheduler.runAfter(0, internal.campaigns.audienceCountJob.step, {
				jobId,
				generation,
			});
		}
	},
});
