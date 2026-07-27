/**
 * Contact engagement score — the Convex plumbing around the pure core in
 * `engagementScore.ts` (deliverability plan P0-2).
 *
 * Two write paths, one scoring model:
 *
 *  - INCREMENTAL (hot path). `engagementPatchForActivity` is called by the single
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
 *  - HOURLY BACKFILL. `backfillEngagementScores` re-projects stale contacts so
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
 *
 * BACKFILL CAPACITY IS BOUNDED AND STATED. The tick bound is sized in DOCUMENTS,
 * not contacts, because each contact re-read costs up to
 * `MAX_ACTIVITIES_PER_RECOMPUTE` activity rows — a batch sized in contacts alone
 * can blow the Convex per-transaction read limit and wedge the chain forever on
 * the same stalest head. See `BACKFILL_BATCH_SIZE` for the arithmetic and
 * `BACKFILL_CONTACTS_PER_HOUR` for the resulting deployment capacity.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { ContactActivityType } from '../contactActivities/catalog';
import { toEngagementActivity } from './engagementActivity';
import {
	EMPTY_ENGAGEMENT_STATE,
	computeEngagementScore,
	engagementActivityKey,
	foldActivity,
	scoreFromState,
	type EngagementActivity,
	type EngagementScoreState,
} from './engagementScore';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Newest activities loaded for a full recompute. Older terms are ~0 anyway. */
export const MAX_ACTIVITIES_PER_RECOMPUTE = 500;

/**
 * Documents ONE backfill transaction may read. A Convex mutation dies somewhere
 * around ~32k document reads (the same limit `contacts/analytics.ts` and
 * `campaigns/audienceResolution.ts` are written against); we stay an order of
 * magnitude under it because a throw here is not a lost batch, it is a WEDGE —
 * the transaction rolls back, no row is stamped, and the identical stalest head
 * is re-selected on the next tick forever.
 */
export const BACKFILL_READ_BUDGET_DOCS = 5_000;

/**
 * Contacts re-projected per batch, sized in DOCUMENTS: one contact row plus up
 * to `MAX_ACTIVITIES_PER_RECOMPUTE` activity rows each. 9 x 501 = 4,509 reads
 * worst case, comfortably inside the budget above. This lands on the same order
 * as the repo's other crons with a per-item sub-scan (`checklistSweepState.ts`
 * uses 5, `segments.ts` uses 10) — deliberately small, because the cost of a
 * batch is set by the heaviest contact in it, not the average one.
 */
export const BACKFILL_BATCH_SIZE = Math.max(
	1,
	Math.floor(BACKFILL_READ_BUDGET_DOCS / (MAX_ACTIVITIES_PER_RECOMPUTE + 1))
);

/** Batches a single run chains through. Bounds the whole tick. */
export const BACKFILL_MAX_BATCHES = 200;

/**
 * Deployment capacity, stated because "hourly" is a claim about convergence and
 * a bounded cron only converges up to its bound: 9 x 200 = 1,800 contacts per
 * tick, ~43,200 per day. A book larger than that re-projects on a longer cycle
 * than `ENGAGEMENT_SCORE_STALE_MS` — scores stay correct, they just decay in
 * coarser steps, and the hot path keeps every ACTIVE contact fresh regardless.
 * The cron logs when a tick ends with work still queued, so the operator can
 * see it rather than infer it.
 */
export const BACKFILL_CONTACTS_PER_HOUR = BACKFILL_BATCH_SIZE * BACKFILL_MAX_BATCHES;

/**
 * A cached score older than this is stale. Slightly under 24h so a daily cycle
 * always reconsiders everything the previous one touched.
 */
export const ENGAGEMENT_SCORE_STALE_MS = 20 * 60 * 60 * 1000;

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

	// STICKY, BUT NOT UNCLEARABLE. `.take(MAX_ACTIVITIES_PER_RECOMPUTE)` reads the
	// NEWEST rows, so a chatty contact's hard bounce can fall out of view while
	// still being inside the lookback window; carrying the cached suppression
	// forward keeps such a contact suppressed. It is scoped to the window on
	// purpose: once the suppressing event is older than `RECOMPUTE_LOOKBACK_MS`
	// — or once its row is corrected/removed and
	// `clearEngagementSuppression` forces a recompute — the contact recovers.
	// Without that scope a bounce recorded in error would pin the contact to 0
	// forever with no reversal path anywhere in the module.
	const cached = contact.engagementScoreState;
	const cachedSuppressedAt =
		cached !== undefined && cached.isSuppressed ? cached.suppressedAt : undefined;

	const state: EngagementScoreState =
		result.state.isSuppressed || cachedSuppressedAt === undefined || cachedSuppressedAt < since
			? result.state
			: { ...result.state, isSuppressed: true, suppressedAt: cachedSuppressedAt };
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
	activityType: ContactActivityType;
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

	// THE SAME fold the full recompute runs — `foldActivity` is the single
	// implementation, so the hot path cannot drift from the backfill.
	const folded = foldActivity(base, baseAt, activity);

	const projected = scoreFromState({
		state: folded.state,
		stateAt: folded.stateAt,
		tenureStartedAt: args.contact.createdAt,
		now,
	});

	return buildScorePatch(args.contact, { score: projected.score, state: projected.state }, now)
		.patch;
}

// ─── Hourly backfill ────────────────────────────────────────────────────────

/**
 * Re-project the stalest contacts. Bounded per invocation IN DOCUMENTS (see
 * `BACKFILL_BATCH_SIZE`), chaining itself while work remains and
 * `batchesRemaining` allows, so one tick converges up to
 * `BACKFILL_CONTACTS_PER_HOUR` contacts and then stops.
 *
 * `batchSize` is caller-supplied only so tests can shrink it; it is clamped to
 * `BACKFILL_BATCH_SIZE` because the clamp is what keeps a single transaction
 * inside the read budget. An unclamped caller could otherwise hand the cron a
 * batch big enough to throw — and a throw wedges the chain permanently, since
 * the rollback re-presents the identical stalest head next tick.
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
		/** True when this batch stopped on the batch budget, not on empty work. */
		isBudgetExhausted: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - ENGAGEMENT_SCORE_STALE_MS;
		const batchSize = Math.max(
			1,
			Math.min(args.batchSize ?? BACKFILL_BATCH_SIZE, BACKFILL_BATCH_SIZE)
		);
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
		const isBudgetExhausted = !isDone && batchesRemaining <= 1;
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

		if (isBudgetExhausted) {
			// The chain's return value is dropped, so the only way an operator can
			// see "the book is bigger than one tick's capacity" is a log line.
			console.warn(
				`[engagementScoreBackfill] tick exhausted its ${BACKFILL_MAX_BATCHES}-batch budget ` +
					`(~${BACKFILL_CONTACTS_PER_HOUR} contacts) with stale contacts still queued; ` +
					`scores re-project on a longer cycle than ${ENGAGEMENT_SCORE_STALE_MS}ms`
			);
		}

		return { scanned, rescored, isDone, isBudgetExhausted };
	},
});

/**
 * Force a full recompute for one contact. Internal-only escape hatch: tests
 * drive it, and an operator can invoke it from the Convex dashboard to
 * re-derive one contact immediately instead of waiting for the backfill to
 * reach it (for example right after correcting a mis-recorded bounce — see
 * `clearEngagementSuppression`, which is that flow with the sticky suppression
 * dropped first).
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

/**
 * THE REVERSAL PATH for suppression. A hard bounce or complaint recorded in
 * error zeroes a healthy contact, and the recompute deliberately carries that
 * suppression forward while its instant is inside the lookback window — so
 * deleting or correcting the offending `contactActivities` row is not, on its
 * own, enough. This drops the cached suppression and re-derives the score from
 * whatever the timeline now says. If the offending row is still there, the
 * recompute simply re-suppresses; fix the row first.
 *
 * Returns the score after the recompute, or `null` for a missing/soft-deleted
 * contact.
 */
export const clearEngagementSuppression = internalMutation({
	args: { contactId: v.id('contacts') },
	returns: v.union(v.number(), v.null()),
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) return null;

		const cached = contact.engagementScoreState;
		if (cached !== undefined) {
			// Rebuild the state WITHOUT `suppressedAt` — an explicit `undefined` is
			// not a storable Convex value, so the field has to be absent, not nulled.
			await ctx.db.patch(args.contactId, {
				engagementScoreState: {
					raw: cached.raw,
					softBounceRaw: cached.softBounceRaw,
					isSuppressed: false,
					...(cached.lastFoldedKey !== undefined ? { lastFoldedKey: cached.lastFoldedKey } : {}),
				},
			});
		}

		const reloaded = await ctx.db.get(args.contactId);
		if (!reloaded) return null;
		const { score } = await recomputeContactEngagementScore(ctx, reloaded, Date.now());
		return score;
	},
});
