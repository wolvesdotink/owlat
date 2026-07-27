/**
 * Sunset policy — the PURE decision core (deliverability plan P4-4, D15).
 *
 * WHY IT EXISTS. Unengaged recipients are the dominant source of spam-folder
 * placement and spam-trap hits, and those are the two things that pin a young
 * VPS IP at the bottom. Hard bounces and complaints are suppressed today
 * (`blockedEmails`), but nothing stops us sending to an address that has
 * ignored nine months of mail. This module decides, per contact, whether that
 * contact should move onto a RE-ENGAGEMENT TRACK (after N quiet days) or be
 * AUTO-SUPPRESSED (after M quiet days).
 *
 * SHIPPED ON, NOT OFF. A hygiene feature that defaults to disabled protects
 * nobody, so the deployment-wide default is ENABLED at a deliberately
 * conservative 180 / 270 days (see `SUNSET_POLICY_DEFAULTS`). Operators tune it
 * per topic; the tuning is a merge, not a replacement (`resolveSunsetPolicy`).
 *
 * BUILT ON P0-2, NOT BESIDE IT. "Has this contact engaged" is already answered
 * by the engagement machinery: `analytics/engagementActivity.ts` owns the ONE
 * table of which `contactActivities` literals count as engagement, and the
 * sunset engine derives its "last engagement" instant from that same table
 * (see `contacts/sunsetEngine.ts`). Nothing here re-derives engagement from raw
 * activities a second time.
 *
 * SAFETY IS THE POINT. Auto-suppression is the most destructive thing in the
 * deliverability plan, so every path that can suppress is guarded BEFORE any
 * arithmetic runs, and each guard has a named reason that reaches the audit
 * log:
 *
 *   - a disabled policy never fires;
 *   - an operator override never fires;
 *   - a non-finite / negative / skewed clock never fires (a timestamp in the
 *     future is evidence the clock is wrong, not that the contact is quiet);
 *   - an EMPTY ACTIVITY HISTORY never fires — absence of history is not
 *     evidence of disengagement, it is absence of measurement;
 *   - a contact younger than the window it would be judged against never
 *     fires, so a brand-new contact is structurally unsuppressable;
 *   - a contact we have never actually sent to never fires;
 *   - a globally-unsubscribed contact never fires (it already receives no
 *     marketing mail, and suppressing it would also block the transactional
 *     mail it explicitly asked for);
 *   - a suppressed contact is never auto-resurrected — coming back is an
 *     operator action with its own audit entry.
 *
 * PURITY. Nothing in this module reads the database, the clock or the
 * environment: `now` and every fact are parameters, so the fixture tables in
 * `__tests__/sunset*.test.ts` are fully deterministic.
 */

const MS_PER_DAY = 86_400_000;

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Quiet days before a contact moves onto the re-engagement track. */
export const SUNSET_REENGAGE_AFTER_DAYS = 180;

/** Quiet days before a contact is auto-suppressed. */
export const SUNSET_SUPPRESS_AFTER_DAYS = 270;

/**
 * The deployment-wide default, used whenever no `sunsetPolicies` row exists.
 * ENABLED out of the box — pinned by `__tests__/sunsetDefaults.test.ts`.
 */
export const SUNSET_POLICY_DEFAULTS: Readonly<SunsetPolicy> = Object.freeze({
	isEnabled: true,
	reengageAfterDays: SUNSET_REENGAGE_AFTER_DAYS,
	suppressAfterDays: SUNSET_SUPPRESS_AFTER_DAYS,
});

/** Lower bound on a configured window. Below this the policy is treated as invalid. */
export const SUNSET_MIN_WINDOW_DAYS = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

export type SunsetPolicy = {
	isEnabled: boolean;
	reengageAfterDays: number;
	suppressAfterDays: number;
};

/** A stored override row: every field optional, absent means "inherit". */
export type SunsetPolicyOverride = {
	isEnabled?: boolean | undefined;
	reengageAfterDays?: number | undefined;
	suppressAfterDays?: number | undefined;
};

/** Where a contact sits on the sunset track. Absent on a legacy row means `engaged`. */
export type SunsetStage = 'engaged' | 'reengagement' | 'suppressed';

export type SunsetAction =
	| 'hold'
	| 'enter_reengagement'
	| 'suppress'
	/** Back to `engaged` from the re-engagement track — the contact engaged again. */
	| 'resume';

/**
 * Why the engine did what it did. Every verdict carries one, it reaches the
 * audit log verbatim, and the KPI is that no transition is ever unexplained.
 */
export type SunsetReason =
	| 'clock_skew'
	| 'policy_disabled'
	| 'invalid_policy'
	| 'operator_override'
	| 'no_email'
	| 'globally_unsubscribed'
	| 'no_send_history'
	| 'insufficient_tenure'
	| 'already_suppressed'
	| 'engaged_recently'
	| 'quiet_past_reengage_window'
	| 'quiet_past_suppress_window';

/**
 * Everything the decision needs, all supplied by the caller. `undefined`
 * consistently means "we have no measurement", never "zero".
 */
export type SunsetFacts = {
	now: number;
	/** Contact row creation instant — the tenure clock. */
	createdAt: number;
	/** Newest open/click/reply, per the P0-2 engagement literals. */
	lastEngagementAt?: number | undefined;
	/** Oldest `email_sent` — when this contact first became measurable. */
	firstMessagedAt?: number | undefined;
	/** True when we have ever actually sent this contact mail. */
	hasSendHistory: boolean;
	/** False when the contact row carries no email address at all. */
	hasEmail: boolean;
	/** `contacts.unsubscribedAt` is set — global marketing opt-out. */
	isGloballyUnsubscribed: boolean;
	/** The contact is already on `blockedEmails` for ANY reason. */
	isAlreadySuppressed: boolean;
	/** Operator override (`contacts.sunsetExemptAt`) — never sunset this contact. */
	isExempt: boolean;
	/** Current stage; absent legacy rows are passed as `'engaged'`. */
	stage: SunsetStage;
};

/**
 * A verdict that changes nothing. A hold is reached from guards that run BEFORE
 * any arithmetic, so it deliberately carries no day counts: there is no honest
 * number to report when the reason for holding is "we could not measure".
 */
export type SunsetHoldVerdict = {
	action: 'hold';
	/** The stage the contact stays in. */
	stage: SunsetStage;
	reason: SunsetReason;
};

/**
 * A verdict that moves the contact. Every one of these is reached only after
 * the guards passed, so the day counts are always real numbers — which is why
 * they are non-optional here and there is no sentinel anywhere downstream.
 */
export type SunsetMeasuredVerdict = {
	action: 'enter_reengagement' | 'suppress' | 'resume';
	/** The stage the contact should be in after `action` is applied. */
	stage: SunsetStage;
	reason: SunsetReason;
	/** Days since the last engagement, or since the first send if it never engaged. */
	quietDays: number;
	/** Days since the contact row was created. */
	tenureDays: number;
};

/** Discriminated on `action`: measured verdicts carry numbers, holds do not. */
export type SunsetVerdict = SunsetHoldVerdict | SunsetMeasuredVerdict;

// ─── Policy resolution ──────────────────────────────────────────────────────

function isPositiveFinite(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

/** Apply one override on top of a base policy. Absent fields inherit. */
function applyOverride(
	base: SunsetPolicy,
	override: SunsetPolicyOverride | undefined
): SunsetPolicy {
	if (override === undefined) return base;
	return {
		isEnabled: override.isEnabled ?? base.isEnabled,
		reengageAfterDays: isPositiveFinite(override.reengageAfterDays)
			? override.reengageAfterDays
			: base.reengageAfterDays,
		suppressAfterDays: isPositiveFinite(override.suppressAfterDays)
			? override.suppressAfterDays
			: base.suppressAfterDays,
	};
}

/**
 * Combine the per-topic policies that apply to one contact into the single
 * policy the engine judges it by.
 *
 * THE COMBINATION IS DELIBERATELY THE MOST LENIENT ONE. A contact subscribed to
 * a topic whose operator disabled sunsetting must not be suppressed because a
 * second topic left the default on — the conservative reading of two
 * conflicting operator intents is "don't suppress". Likewise the windows are
 * the MAXIMUM across the applicable topics, so the contact is judged by the
 * most patient policy it is covered by.
 *
 * `globalOverride` is the deployment-wide row (`sunsetPolicies.topicId ===
 * undefined`); each topic override is layered on top of it. A contact in no
 * topics at all is judged by the global policy alone.
 *
 * A DEPLOYMENT-WIDE OPT-OUT IS ABSOLUTE. The global row is itself one of the
 * applicable policies, so "most lenient wins" makes an operator who turned the
 * engine off deployment-wide beat a topic row that left it on — the engine is
 * off everywhere, for members of a topic and non-members alike. Only turning
 * the engine back on globally re-enables it.
 */
export function resolveSunsetPolicy(args: {
	globalOverride?: SunsetPolicyOverride | undefined;
	topicOverrides?: readonly (SunsetPolicyOverride | undefined)[] | undefined;
}): SunsetPolicy {
	const base = applyOverride({ ...SUNSET_POLICY_DEFAULTS }, args.globalOverride);
	const topicOverrides = args.topicOverrides ?? [];
	if (topicOverrides.length === 0) return base;

	// Seeded from the deployment-wide policy, not from `true`: the global row is
	// an applicable policy in its own right, so a global opt-out survives every
	// topic override rather than being overwritten by the first one that is on.
	let isEnabled = base.isEnabled;
	let reengageAfterDays = 0;
	let suppressAfterDays = 0;
	for (const override of topicOverrides) {
		const effective = applyOverride(base, override);
		if (!effective.isEnabled) isEnabled = false;
		reengageAfterDays = Math.max(reengageAfterDays, effective.reengageAfterDays);
		suppressAfterDays = Math.max(suppressAfterDays, effective.suppressAfterDays);
	}
	return { isEnabled, reengageAfterDays, suppressAfterDays };
}

/**
 * Is the resolved policy usable? A window that is non-finite, below
 * `SUNSET_MIN_WINDOW_DAYS`, or ordered backwards (suppress before re-engage) is
 * a misconfiguration, and the engine HOLDS on it rather than guessing.
 */
export function isSunsetPolicyValid(policy: SunsetPolicy): boolean {
	return (
		isPositiveFinite(policy.reengageAfterDays) &&
		isPositiveFinite(policy.suppressAfterDays) &&
		policy.reengageAfterDays >= SUNSET_MIN_WINDOW_DAYS &&
		policy.suppressAfterDays >= SUNSET_MIN_WINDOW_DAYS &&
		policy.suppressAfterDays >= policy.reengageAfterDays
	);
}

// ─── The decision ───────────────────────────────────────────────────────────

function hold(reason: SunsetReason, stage: SunsetStage): SunsetHoldVerdict {
	return { action: 'hold', stage, reason };
}

/**
 * A timestamp is trustworthy only if it is a finite, positive instant that is
 * not in the future. Anything else means the clock (ours or the writer's) is
 * wrong, and a wrong clock must never be able to suppress anybody.
 *
 * ABSENCE PASSES, and the name says so: an unmeasured instant is not a skewed
 * one. The three call sites all treat "we never saw this fact" separately —
 * `hasSendHistory` for the send side, `lastEngagementAt ?? firstMessagedAt` for
 * the engagement side — so absence must not be mistaken for a bad clock here.
 */
function isTrustworthyInstantOrAbsent(value: number | undefined, now: number): boolean {
	if (value === undefined) return true;
	return Number.isFinite(value) && value > 0 && value <= now;
}

/**
 * THE decision. Guards first, arithmetic second: by the time a day count is
 * computed, every unsafe input has already returned a `hold`.
 */
export function evaluateSunset(facts: SunsetFacts, policy: SunsetPolicy): SunsetVerdict {
	const stage = facts.stage;

	// 1. The clock itself. A non-finite or non-positive `now` disqualifies every
	//    later comparison, so nothing downstream may run.
	if (!Number.isFinite(facts.now) || facts.now <= 0) return hold('clock_skew', stage);

	// 2. Operator intent beats everything the engine might infer.
	if (!policy.isEnabled) return hold('policy_disabled', stage);
	if (!isSunsetPolicyValid(policy)) return hold('invalid_policy', stage);
	if (facts.isExempt) return hold('operator_override', stage);

	// 3. Nothing to suppress / nothing that would benefit from suppressing.
	if (!facts.hasEmail) return hold('no_email', stage);
	if (facts.isGloballyUnsubscribed) return hold('globally_unsubscribed', stage);

	// 4. Skewed or future-dated inputs. Checked before any subtraction so a
	//    future `createdAt` can never present as a huge negative tenure.
	if (
		!isTrustworthyInstantOrAbsent(facts.createdAt, facts.now) ||
		!isTrustworthyInstantOrAbsent(facts.lastEngagementAt, facts.now) ||
		!isTrustworthyInstantOrAbsent(facts.firstMessagedAt, facts.now)
	) {
		return hold('clock_skew', stage);
	}

	// 5. ABSENCE OF HISTORY IS NOT EVIDENCE OF DISENGAGEMENT. A contact we have
	//    never sent to has produced no opportunity to engage, so it can never be
	//    "unengaged" — regardless of how old the row is.
	if (!facts.hasSendHistory || facts.firstMessagedAt === undefined) {
		return hold('no_send_history', stage);
	}

	const tenureDays = (facts.now - facts.createdAt) / MS_PER_DAY;
	// Quiet since the last engagement, or — never having engaged — since the
	// first time we gave the contact something to engage WITH.
	const quietSince = Math.max(
		facts.lastEngagementAt ?? facts.firstMessagedAt,
		facts.firstMessagedAt
	);
	const quietDays = (facts.now - quietSince) / MS_PER_DAY;
	// How long the contact has been measurable at all. Judging a 20-day-old
	// contact against a 270-day window is a category error, so both the tenure
	// and the measurement span must cover the window being applied.
	const measurableDays = (facts.now - facts.firstMessagedAt) / MS_PER_DAY;

	// 6. Recent engagement resets the track. A suppressed contact is NOT
	//    auto-resurrected: coming back is an operator action (`restore`).
	if (quietDays < policy.reengageAfterDays) {
		if (stage === 'reengagement') {
			return {
				action: 'resume',
				stage: 'engaged',
				reason: 'engaged_recently',
				quietDays,
				tenureDays,
			};
		}
		return hold('engaged_recently', stage);
	}

	if (stage === 'suppressed' || facts.isAlreadySuppressed) {
		return hold('already_suppressed', stage);
	}

	const covers = (windowDays: number): boolean =>
		quietDays >= windowDays && tenureDays >= windowDays && measurableDays >= windowDays;

	if (covers(policy.suppressAfterDays)) {
		return {
			action: 'suppress',
			stage: 'suppressed',
			reason: 'quiet_past_suppress_window',
			quietDays,
			tenureDays,
		};
	}

	if (covers(policy.reengageAfterDays)) {
		if (stage === 'reengagement') {
			return hold('quiet_past_reengage_window', stage);
		}
		return {
			action: 'enter_reengagement',
			stage: 'reengagement',
			reason: 'quiet_past_reengage_window',
			quietDays,
			tenureDays,
		};
	}

	// Quiet long enough on paper, but the contact has not existed / been
	// measurable long enough for that to mean anything.
	return hold('insufficient_tenure', stage);
}
