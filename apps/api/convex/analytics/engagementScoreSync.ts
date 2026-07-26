/**
 * Contact engagement score — the Convex plumbing around the pure core in
 * `engagementScore.ts` (deliverability plan P0-2).
 *
 * Two write paths, one scoring model:
 *
 *  - INCREMENTAL (hot path). `applyEngagementActivity` is called by the single
 *    contact-activity writer (`contactActivities/writer.ts`) when a relevant
 *    activity lands. It decays the CACHED accumulator forward to the activity's
 *    timestamp and folds the new term in — O(1), no activity-timeline read, no
 *    extra document write beyond the contact patch the writer already makes.
 *    Because a sum of exponentially-decayed terms itself decays exponentially,
 *    this is arithmetically identical to a full recompute — with one bounded
 *    exception. The full recompute sees the whole window and drops EVERY exact
 *    (kind, occurredAt) duplicate; the hot path only remembers the last fold
 *    (`lastFoldedKey`), so it collapses a redelivered webhook — the realistic
 *    case — but a duplicate separated by another activity still counts twice
 *    until the next full recompute corrects it (at most 20h later, and the
 *    error is one activity's decayed weight).
 *  - NIGHTLY BACKFILL. `backfillEngagementScores` re-projects stale contacts so
 *    a score decays on the clock, not only when the contact does something. It
 *    walks a bounded prefix of the `by_engagement_score_updated_at` range —
 *    never a `.collect()` over the table (ADR-0042).
 *
 * THE CURSOR IS THE RANGE. Recomputing a contact stamps
 * `engagementScoreUpdatedAt = now`, which removes it from the stale range, so
 * the next batch resumes exactly where the last one stopped without carrying an
 * opaque cursor that could be invalidated by a concurrent write. Never-scored
 * rows sort first (a missing field precedes every number in a Convex index), so
 * a fresh deployment converges from the front.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import {
	EMPTY_ENGAGEMENT_STATE,
	applyActivity,
	computeEngagementScore,
	decayState,
	engagementActivityKey,
	scoreFromState,
	toEngagementActivity,
	type EngagementActivity,
	type EngagementScoreState,
} from './engagementScore';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Contacts re-projected per batch. */
export const BACKFILL_BATCH_SIZE = 100;

/** Batches a single nightly run chains through. Bounds the whole tick. */
export const BACKFILL_MAX_BATCHES = 50;

/**
 * A cached score older than this is stale. Slightly under 24h so a nightly run
 * always reconsiders everything the previous run touched.
 */
export const ENGAGEMENT_SCORE_STALE_MS = 20 * 60 * 60 * 1000;

/** Newest activities loaded for a full recompute. Older terms are ~0 anyway. */
export const MAX_ACTIVITIES_PER_RECOMPUTE = 500;

/**
 * Lookback window for a full recompute: 400 days, ~8.9 engagement half-lives.
 * A term that old is worth 2^-8.9 ≈ 0.2% of its original weight — below the
 * rounding step of the 0-100 score, so the truncation is invisible.
 */
export const RECOMPUTE_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;

// ─── Shared write helper ────────────────────────────────────────────────────

type ScorePatch = {
	engagementScore?: number;
	engagementScoreUpdatedAt: number;
	engagementScoreState: EngagementScoreState;
};

/**
 * Build the contact patch for a newly-projected score. `engagementScore` is
 * omitted when the value did not move, so an unchanged score is never rewritten
 * — only the accumulator and its as-of stamp advance (they MUST advance
 * together; the accumulator is meaningless without the instant it belongs to).
 */
function buildScorePatch(
	contact: Doc<'contacts'>,
	next: { score: number; state: EngagementScoreState },
	now: number
): { patch: ScorePatch; changed: boolean } {
	const changed = contact.engagementScore !== next.score;
	const patch: ScorePatch = {
		engagementScoreUpdatedAt: now,
		engagementScoreState: next.state,
	};
	if (changed) patch.engagementScore = next.score;
	return { patch, changed };
}

// ─── Full recompute ─────────────────────────────────────────────────────────

/**
 * Re-derive a contact's score from its activity timeline. Bounded: the newest
 * `MAX_ACTIVITIES_PER_RECOMPUTE` activities inside `RECOMPUTE_LOOKBACK_MS`, read
 * through `by_contact_and_occurred_at`.
 */
export async function recomputeContactEngagementScore(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	now: number
): Promise<{ score: number; changed: boolean }> {
	const since = now - RECOMPUTE_LOOKBACK_MS;
	const rows = await ctx.db
		.query('contactActivities')
		.withIndex('by_contact_and_occurred_at', (q) =>
			q.eq('contactId', contact._id).gte('occurredAt', since)
		)
		.order('desc')
		.take(MAX_ACTIVITIES_PER_RECOMPUTE);

	const activities: EngagementActivity[] = [];
	for (const row of rows) {
		const mapped = toEngagementActivity({
			activityType: row.activityType,
			occurredAt: row.occurredAt,
			bounceType: row.metadata?.bounceType,
		});
		if (mapped) activities.push(mapped);
	}

	const result = computeEngagementScore({
		activities,
		tenureStartedAt: contact.createdAt,
		now,
	});
	// A hard bounce / complaint is terminal, so a suppression already recorded on
	// the cached state survives a recompute whose window no longer reaches it.
	const state: EngagementScoreState = {
		...result.state,
		isSuppressed: result.state.isSuppressed || contact.engagementScoreState?.isSuppressed === true,
	};
	const score = state.isSuppressed ? 0 : result.score;

	const { patch, changed } = buildScorePatch(contact, { score, state }, now);
	await ctx.db.patch(contact._id, patch);
	return { score, changed };
}

// ─── Incremental (hot path) ─────────────────────────────────────────────────

/**
 * Fold one freshly-recorded activity into the cached score. Returns the patch
 * fields for the CALLER to merge into its own contact patch (the activity
 * writer already patches the contact for the hasOpened/hasClicked
 * denormalization — one document write, not two).
 *
 * Returns `null` in exactly three cases, and otherwise ALWAYS returns a patch
 * (even when the rounded score is unchanged — the accumulator and its as-of
 * stamp still advance, and `buildScorePatch` omits the score field itself):
 *
 *  - the contact is soft-deleted;
 *  - the activity literal is one the score does not react to
 *    (`toEngagementActivity` returns null);
 *  - the activity is an exact repeat of the last one folded (same kind, same
 *    clamped `occurredAt`) — a redelivered webhook is one engagement.
 *
 * COLD CACHE. When no accumulator exists yet the fold seeds from
 * `EMPTY_ENGAGEMENT_STATE` rather than reading the timeline (no unbounded read
 * on the send hot path), so a contact with pre-existing history is UNDER-counted
 * from this write until a full recompute re-derives it. That patch stamps the
 * row fresh, so it only re-enters the stale range — and gets corrected — after
 * `ENGAGEMENT_SCORE_STALE_MS` (20h); the score is optional and advisory
 * everywhere it is consumed, and only ever errs low.
 */
export function engagementPatchForActivity(args: {
	contact: Doc<'contacts'>;
	activityType: string;
	occurredAt: number;
	bounceType?: string | undefined;
	now: number;
}): ScorePatch | null {
	if (args.contact.deletedAt !== undefined) return null;

	const mapped = toEngagementActivity({
		activityType: args.activityType,
		occurredAt: args.occurredAt,
		bounceType: args.bounceType,
	});
	if (!mapped) return null;

	// Clamp a future timestamp to `now` exactly as the pure core's
	// `normalizeActivities` does. A malformed provider date or a skewed caller
	// clock must not fold a term at full never-decayed weight, and must never
	// stamp `engagementScoreUpdatedAt` ahead of the wall clock — that would pin
	// the row outside the backfill's stale range until real time caught up, so
	// nothing could correct the inflated score.
	const now = args.now;
	const activity: EngagementActivity = {
		kind: mapped.kind,
		occurredAt: Number.isFinite(mapped.occurredAt) ? Math.min(mapped.occurredAt, now) : now,
	};

	const cached = args.contact.engagementScoreState;
	// Likewise clamp the accumulator's as-of stamp: a legacy row stamped in the
	// future would otherwise fold at an instant we are not allowed to stamp.
	const cachedAt =
		args.contact.engagementScoreUpdatedAt === undefined
			? undefined
			: Math.min(args.contact.engagementScoreUpdatedAt, now);

	// Same event recorded twice → one engagement, matching the full recompute.
	const key = engagementActivityKey(activity.kind, activity.occurredAt);
	if (cached?.lastFoldedKey === key) return null;

	// No accumulator yet → seed from empty (see the cold-cache note above).
	const base = cached ?? EMPTY_ENGAGEMENT_STATE;
	const baseAt = cached !== undefined && cachedAt !== undefined ? cachedAt : activity.occurredAt;

	// Fold at max(baseAt, occurredAt) so a LATE-ARRIVING activity (a backfilled
	// open, an out-of-order webhook) is decayed forward to the accumulator's
	// instant instead of the accumulator being decayed backwards to the
	// activity's. Arrival order therefore cannot change the answer — the
	// incremental path stays equal to a full recompute.
	const foldAt = Math.max(baseAt, activity.occurredAt);
	const decayedBase = decayState(base, baseAt, foldAt);
	const contribution = decayState(
		applyActivity(EMPTY_ENGAGEMENT_STATE, activity.kind),
		activity.occurredAt,
		foldAt
	);
	const folded: EngagementScoreState = {
		raw: decayedBase.raw + contribution.raw,
		softBounceRaw: decayedBase.softBounceRaw + contribution.softBounceRaw,
		isSuppressed: decayedBase.isSuppressed || contribution.isSuppressed,
		lastFoldedKey: key,
	};

	const projected = scoreFromState({
		state: folded,
		stateAt: foldAt,
		tenureStartedAt: args.contact.createdAt,
		now,
	});

	return buildScorePatch(args.contact, { score: projected.score, state: projected.state }, now)
		.patch;
}

// ─── Nightly backfill ───────────────────────────────────────────────────────

/**
 * Re-project the stalest contacts. Bounded per invocation; chains itself while
 * work remains and `batchesRemaining` allows, so a single nightly tick converges
 * up to `BACKFILL_BATCH_SIZE * BACKFILL_MAX_BATCHES` contacts and then stops.
 */
export const backfillEngagementScores = internalMutation({
	args: {
		batchesRemaining: v.optional(v.number()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		rescored: v.number(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - ENGAGEMENT_SCORE_STALE_MS;
		const batchSize = Math.max(1, Math.min(args.batchSize ?? BACKFILL_BATCH_SIZE, 500));
		const batchesRemaining = Math.max(
			0,
			Math.min(args.batchesRemaining ?? BACKFILL_MAX_BATCHES, BACKFILL_MAX_BATCHES)
		);

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_engagement_score_updated_at', (q) =>
				q.lt('engagementScoreUpdatedAt', staleBefore)
			)
			.order('asc')
			.take(batchSize);

		let scanned = 0;
		let rescored = 0;
		for (const contact of candidates) {
			scanned += 1;
			if (contact.deletedAt !== undefined) {
				// Soft-deleted rows would otherwise pin the head of the range forever.
				await ctx.db.patch(contact._id, { engagementScoreUpdatedAt: now });
				continue;
			}
			const { changed } = await recomputeContactEngagementScore(ctx, contact, now);
			if (changed) rescored += 1;
		}

		const isDone = candidates.length < batchSize;
		if (!isDone && batchesRemaining > 1) {
			await ctx.scheduler.runAfter(
				0,
				internal.analytics.engagementScoreSync.backfillEngagementScores,
				{
					batchesRemaining: batchesRemaining - 1,
					batchSize,
				}
			);
		}

		return { scanned, rescored, isDone };
	},
});

/**
 * Force a full recompute for one contact. Internal-only escape hatch for tests
 * and for the incremental path's cold-cache case.
 */
export const recomputeContactScore = internalMutation({
	args: { contactId: v.id('contacts') },
	returns: v.union(v.number(), v.null()),
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) return null;
		const { score } = await recomputeContactEngagementScore(ctx, contact, Date.now());
		return score;
	},
});
