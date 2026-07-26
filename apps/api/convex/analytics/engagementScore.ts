/**
 * Contact engagement score — the PURE decision core (deliverability plan D15).
 *
 * A 0-100, recency-weighted measure of how engaged a contact is with our mail,
 * derived from the `contactActivities` timeline. Nothing in this module reads
 * the database, the clock, or the environment: every function takes its inputs
 * (including `now`) as parameters and returns a value, so the fixture table in
 * `__tests__/engagementScore*.test.ts` is fully deterministic.
 *
 * WHY IT EXISTS. The MTA already consumes an `engagementScore` — the priority
 * bands in `apps/mta/src/intelligence/engagementPriority.ts` cut at 80/50/20 —
 * but Convex never set it (the shipped docs claim it is "supplied by Convex";
 * that claim was false). This module is the producer. The share controller's
 * stratified assignment (plan P2-5) derives a recipient's percentile within a
 * cell from the same score via `engagementPercentile` below — the scoring logic
 * is NOT duplicated there.
 *
 * THE MODEL. One exponentially-decayed accumulator, folded activity by
 * activity in chronological order:
 *
 *   raw(t)  = Σ weight(activity) · 2^(-(t - occurredAt) / HALF_LIFE)
 *   prior(t)= TENURE_PRIOR_WEIGHT · 2^(-tenureDays / TENURE_PRIOR_HALF_LIFE)
 *   penalty = SOFT_BOUNCE_PENALTY_BASE ^ softBounceRaw(t)
 *   score   = round(100 · (1 - e^(-(raw + prior) · penalty / SATURATION_K)))
 *
 * Four properties fall out of that shape and are each pinned by a test:
 *
 * 1. CONTINUOUS DECAY. Every term decays continuously, so a contact never
 *    jumps a band because a UTC day rolled over.
 * 2. MONOTONICITY. With no new activity the score is non-increasing as `now`
 *    advances — every term shrinks, and the tenure prior shrinks too.
 * 3. FOLD/INCREMENT EQUIVALENCE. Because a sum of exponentially-decayed terms
 *    itself decays exponentially, decaying the accumulator forward and adding
 *    one new term is EXACTLY a full recompute. The hot path can therefore do
 *    O(1) incremental work (`decayState` + `applyActivity`) and the nightly
 *    backfill's full recompute agrees with it. There is one code path.
 * 4. TENURE PRIOR. A brand-new contact with no activity yet is not "cold" —
 *    it is UNMEASURED, and new subscribers are the best-performing cohort. The
 *    prior decays away over the first weeks, so a long-silent contact is cold
 *    while a two-day-old one sits mid-band.
 *
 * CALIBRATION. `SATURATION_K` is chosen so the four bands are actually
 * populated by realistic timelines rather than clumping at one end (a scoring
 * function that maps every real contact into one band makes the MTA priority
 * feature useless). In raw units the cuts land at ~2.0 (20), ~6.2 (50) and
 * ~14.5 (80) — i.e. roughly "one recent open", "two recent opens", "one recent
 * click plus a couple of opens". `__tests__/engagementScore.test.ts` pins the
 * band of eight realistic timelines.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Half-life (days) of an open/click/reply's contribution. */
export const ENGAGEMENT_HALF_LIFE_DAYS = 45;

/** Half-life (days) of the new-contact prior, measured against tenure. */
export const TENURE_PRIOR_HALF_LIFE_DAYS = 21;

/** Raw weight the prior contributes at tenure 0. */
export const TENURE_PRIOR_WEIGHT = 4;

/**
 * Raw weight per activity kind. Clicks weigh materially more than opens (an
 * open can be a proxy prefetch; a click is a human), a reply more still.
 */
export const ENGAGEMENT_WEIGHTS = {
	open: 4,
	click: 12,
	reply: 15,
} as const;

/** Raw weight a soft bounce contributes to the (separate) penalty accumulator. */
export const SOFT_BOUNCE_WEIGHT = 1;

/** Multiplicative penalty applied as base^softBounceRaw. */
export const SOFT_BOUNCE_PENALTY_BASE = 0.85;

/** Saturation constant of the raw → 0-100 curve. See CALIBRATION above. */
export const SATURATION_K = 9;

/**
 * Band cut points. These MIRROR `PRIORITY_BANDS` in
 * `apps/mta/src/intelligence/engagementPriority.ts` (80/50/20) — the MTA is the
 * consumer, so the producer must speak the same cuts.
 */
export const ENGAGEMENT_BANDS = { high: 80, medium: 50, low: 20 } as const;

export type EngagementBand = 'high' | 'medium' | 'low' | 'cold';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Activity kinds the score reacts to. Everything else is ignored. */
export type EngagementActivityKind =
	| 'open'
	| 'click'
	| 'reply'
	| 'soft_bounce'
	| 'hard_bounce'
	| 'complaint';

export type EngagementActivity = {
	kind: EngagementActivityKind;
	occurredAt: number;
};

/**
 * The decayed accumulator cached on the contact document. `raw` and
 * `softBounceRaw` are always "as of" the contact's `engagementScoreUpdatedAt`;
 * the two are patched together and must never drift apart.
 */
export type EngagementScoreState = {
	raw: number;
	softBounceRaw: number;
	/** A hard bounce or a spam complaint. Terminal — never cleared. */
	isSuppressed: boolean;
	/**
	 * `engagementActivityKey` of the most recently folded activity. The hot path
	 * collapses an immediately-repeated (kind, occurredAt) — a redelivered
	 * provider webhook is one engagement, not two — which is what the full
	 * recompute does for the whole window. Absent on legacy rows and on a state
	 * that has never folded anything.
	 */
	lastFoldedKey?: string | undefined;
};

/** One tally per activity kind. */
export type EngagementActivityCounts = {
	openCount: number;
	clickCount: number;
	replyCount: number;
	softBounceCount: number;
	hardBounceCount: number;
	complaintCount: number;
};

/**
 * The ONE place a kind is mapped to its tally. `applyActivity` walks the same
 * discriminant for the arithmetic; adding a kind must touch a table, not two
 * cascading switches.
 */
const COUNT_KEY_BY_KIND = {
	open: 'openCount',
	click: 'clickCount',
	reply: 'replyCount',
	soft_bounce: 'softBounceCount',
	hard_bounce: 'hardBounceCount',
	complaint: 'complaintCount',
} as const satisfies Record<EngagementActivityKind, keyof EngagementActivityCounts>;

export type EngagementScoreInputs = EngagementActivityCounts & {
	/** Activities dropped as non-finite, or as exact (kind, occurredAt) dupes. */
	discardedCount: number;
	tenureDays: number;
	decayedEngagement: number;
	decayedSoftBounce: number;
	tenurePrior: number;
	penalty: number;
	/** The saturating curve's argument — `(decayedEngagement + prior) * penalty`. */
	raw: number;
};

export type EngagementScoreResult = {
	score: number;
	state: EngagementScoreState;
	inputs: EngagementScoreInputs;
};

export const EMPTY_ENGAGEMENT_STATE: EngagementScoreState = {
	raw: 0,
	softBounceRaw: 0,
	isSuppressed: false,
};

/**
 * Identity of one folded activity. Two activities sharing a key are the same
 * event recorded twice (a webhook redelivery), never two engagements.
 */
export function engagementActivityKey(kind: EngagementActivityKind, occurredAt: number): string {
	return `${kind}:${occurredAt}`;
}

// ─── Primitives ─────────────────────────────────────────────────────────────

/** 2^(-elapsedMs / halfLifeDays), clamped so negative elapsed never amplifies. */
function decayFactor(elapsedMs: number, halfLifeDays: number): number {
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
	return Math.pow(2, -elapsedMs / (halfLifeDays * MS_PER_DAY));
}

/** Guard against NaN/Infinity leaking in from a corrupt cached state row. */
function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

/**
 * Decay a cached accumulator forward from `fromAt` to `toAt`. Going backwards
 * (clock skew, an out-of-order replay) is a no-op rather than an amplification.
 */
export function decayState(
	state: EngagementScoreState,
	fromAt: number,
	toAt: number
): EngagementScoreState {
	const factor = decayFactor(toAt - fromAt, ENGAGEMENT_HALF_LIFE_DAYS);
	return {
		raw: Math.max(0, finite(state.raw) * factor),
		softBounceRaw: Math.max(0, finite(state.softBounceRaw) * factor),
		isSuppressed: state.isSuppressed === true,
		// Spread conditionally: an explicit `undefined` is not a storable Convex
		// value, and this state is written straight onto the contact document.
		...(state.lastFoldedKey !== undefined ? { lastFoldedKey: state.lastFoldedKey } : {}),
	};
}

/**
 * Fold one activity into an accumulator that is ALREADY decayed to the
 * activity's own timestamp.
 */
export function applyActivity(
	state: EngagementScoreState,
	kind: EngagementActivityKind
): EngagementScoreState {
	switch (kind) {
		case 'open':
			return { ...state, raw: state.raw + ENGAGEMENT_WEIGHTS.open };
		case 'click':
			return { ...state, raw: state.raw + ENGAGEMENT_WEIGHTS.click };
		case 'reply':
			return { ...state, raw: state.raw + ENGAGEMENT_WEIGHTS.reply };
		case 'soft_bounce':
			return { ...state, softBounceRaw: state.softBounceRaw + SOFT_BOUNCE_WEIGHT };
		case 'hard_bounce':
		case 'complaint':
			return { ...state, isSuppressed: true };
		default: {
			const exhaustive: never = kind;
			void exhaustive;
			return state;
		}
	}
}

/**
 * Project a cached accumulator to a 0-100 score at `now`. `stateAt` is the
 * timestamp the accumulator is as-of (the contact's `engagementScoreUpdatedAt`).
 */
export function scoreFromState(args: {
	state: EngagementScoreState;
	stateAt: number;
	tenureStartedAt: number;
	now: number;
}): { score: number; state: EngagementScoreState; tenurePrior: number; penalty: number } {
	const state = decayState(args.state, args.stateAt, args.now);
	if (state.isSuppressed) {
		return { score: 0, state, tenurePrior: 0, penalty: 0 };
	}

	const tenureMs = Math.max(0, finite(args.now) - finite(args.tenureStartedAt, args.now));
	const tenurePrior = TENURE_PRIOR_WEIGHT * decayFactor(tenureMs, TENURE_PRIOR_HALF_LIFE_DAYS);
	const penalty = Math.pow(SOFT_BOUNCE_PENALTY_BASE, state.softBounceRaw);
	const raw = (state.raw + tenurePrior) * penalty;
	const score = Math.round(100 * (1 - Math.exp(-raw / SATURATION_K)));

	return {
		score: Math.min(100, Math.max(0, finite(score))),
		state,
		tenurePrior,
		penalty,
	};
}

// ─── Full recompute ─────────────────────────────────────────────────────────

/**
 * Sanitize + order an activity list: drop non-finite timestamps, clamp future
 * timestamps to `now` (a clock-skewed producer must not out-weigh a real one),
 * drop exact (kind, occurredAt) duplicates (a double-written event is not two
 * engagements), and sort ascending so the fold is deterministic.
 */
function normalizeActivities(
	activities: readonly EngagementActivity[],
	now: number
): { ordered: EngagementActivity[]; discarded: number } {
	const ordered: EngagementActivity[] = [];
	const seen = new Set<string>();
	let discarded = 0;

	for (const activity of activities) {
		if (!Number.isFinite(activity.occurredAt)) {
			discarded += 1;
			continue;
		}
		const occurredAt = Math.min(activity.occurredAt, now);
		const key = engagementActivityKey(activity.kind, occurredAt);
		if (seen.has(key)) {
			discarded += 1;
			continue;
		}
		seen.add(key);
		ordered.push({ kind: activity.kind, occurredAt });
	}

	ordered.sort((a, b) => a.occurredAt - b.occurredAt);
	return { ordered, discarded };
}

/**
 * Full recompute from a timeline. Equivalent — up to float rounding — to
 * folding the same activities incrementally through `decayState` +
 * `applyActivity`, which is what the hot path does.
 *
 * Work is O(n log n) in the number of activities supplied and allocates one
 * array plus one Set of that size; callers are responsible for bounding the
 * list (the loader takes the newest N inside the lookback window).
 */
export function computeEngagementScore(args: {
	activities: readonly EngagementActivity[];
	tenureStartedAt: number;
	now: number;
}): EngagementScoreResult {
	const now = Number.isFinite(args.now) ? args.now : 0;
	const { ordered, discarded } = normalizeActivities(args.activities, now);

	const counts: EngagementActivityCounts = {
		openCount: 0,
		clickCount: 0,
		replyCount: 0,
		softBounceCount: 0,
		hardBounceCount: 0,
		complaintCount: 0,
	};

	let state = EMPTY_ENGAGEMENT_STATE;
	let stateAt = ordered[0]?.occurredAt ?? now;

	for (const activity of ordered) {
		state = applyActivity(decayState(state, stateAt, activity.occurredAt), activity.kind);
		stateAt = activity.occurredAt;
		counts[COUNT_KEY_BY_KIND[activity.kind]] += 1;
	}

	// The newest folded activity's identity, so a hot-path fold of the very same
	// (kind, occurredAt) after this recompute is collapsed rather than doubled.
	const newest = ordered[ordered.length - 1];
	if (newest !== undefined) {
		state = { ...state, lastFoldedKey: engagementActivityKey(newest.kind, newest.occurredAt) };
	}

	const projected = scoreFromState({
		state,
		stateAt,
		tenureStartedAt: args.tenureStartedAt,
		now,
	});

	return {
		score: projected.score,
		state: projected.state,
		inputs: {
			...counts,
			discardedCount: discarded,
			tenureDays: Math.max(0, (now - finite(args.tenureStartedAt, now)) / MS_PER_DAY),
			decayedEngagement: projected.state.raw,
			decayedSoftBounce: projected.state.softBounceRaw,
			tenurePrior: projected.tenurePrior,
			penalty: projected.penalty,
			raw: (projected.state.raw + projected.tenurePrior) * projected.penalty,
		},
	};
}

// ─── Consumer helpers ───────────────────────────────────────────────────────

/** The band a score falls in. Cuts mirror the MTA's `PRIORITY_BANDS`. */
export function engagementBand(score: number): EngagementBand {
	if (!Number.isFinite(score)) return 'cold';
	if (score >= ENGAGEMENT_BANDS.high) return 'high';
	if (score >= ENGAGEMENT_BANDS.medium) return 'medium';
	if (score >= ENGAGEMENT_BANDS.low) return 'low';
	return 'cold';
}

/**
 * The seam plan P2-5 consumes for stratified assignment: a contact's percentile
 * (0-1) within a cohort of scores. `cohortAscending` must be sorted ascending;
 * the result is the fraction of the cohort scoring at or below `score`.
 *
 * An empty cohort has no ordering information, so it returns the neutral 0.5
 * rather than pretending the contact is at either extreme.
 */
export function engagementPercentile(cohortAscending: readonly number[], score: number): number {
	const size = cohortAscending.length;
	if (size === 0) return 0.5;

	// Upper bound: first index whose value is strictly greater than `score`.
	let low = 0;
	let high = size;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const value = cohortAscending[mid];
		if (value === undefined || value <= score) low = mid + 1;
		else high = mid;
	}
	return low / size;
}

// ─── Activity-type mapping ──────────────────────────────────────────────────

/**
 * Map a `contactActivities` row onto a scoring activity. Returns `null` for the
 * activity types the score does not react to (topic changes, property edits,
 * `created`, `email_sent` — a send is our action, not the contact's).
 *
 * `bounceType` is free-form on the activity metadata; anything that is not an
 * explicit hard bounce is treated as soft (fail-soft: we would rather under-
 * suppress than zero a healthy contact on an unrecognised label).
 */
export function toEngagementActivity(args: {
	activityType: string;
	occurredAt: number;
	bounceType?: string | undefined;
}): EngagementActivity | null {
	switch (args.activityType) {
		case 'email_opened':
			return { kind: 'open', occurredAt: args.occurredAt };
		case 'email_clicked':
			return { kind: 'click', occurredAt: args.occurredAt };
		case 'inbound_replied':
			return { kind: 'reply', occurredAt: args.occurredAt };
		case 'email_complained':
			return { kind: 'complaint', occurredAt: args.occurredAt };
		case 'email_bounced':
			return {
				kind: args.bounceType?.toLowerCase() === 'hard' ? 'hard_bounce' : 'soft_bounce',
				occurredAt: args.occurredAt,
			};
		default:
			return null;
	}
}
