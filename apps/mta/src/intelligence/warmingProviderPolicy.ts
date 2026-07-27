/**
 * Per-(IP x mailbox provider) warming policy — the PURE decision core.
 *
 * Warming is per-IP daily today: one cap for an IP, regardless of who the
 * recipient's mailbox provider is. That is not the shape of a young VPS IP's
 * reputation — an IP is routinely TRUSTED AT GOOGLE while still CRAWLING AT
 * MICROSOFT. This module derives a per-provider *cap multiplier* that narrows
 * the shipped per-IP cap for one provider without touching the others.
 *
 * The per-IP cap remains AUTHORITATIVE: the provider cap is derived from it and
 * is always <= it, so the union of provider allowances can never exceed the
 * per-IP daily cap the shipped schedule enforces.
 *
 * Every function here is pure (no clock, no Redis, no env) so the policy can be
 * exhaustively unit-tested against fixtures.
 */

import { ADAPTIVE_WARMING_POLICY } from '@owlat/shared/warming';
import type { SmtpFailureCategory } from './smtpClassifier.js';

export const PROVIDER_WARMING_POLICY = Object.freeze({
	/** A provider with no recorded state is unrestricted — shipped behaviour. */
	defaultCapMultiplier: 1,
	/** Never fully zero: a crawling provider keeps a trickle so it can recover. */
	minimumCapMultiplier: 0.05,
	/** Multiplicative decrease — cheap to retreat. */
	tightenMultiplier: 0.5,
	/** Additive increase — expensive to advance. */
	recoveryStep: 0.1,
	/** A narrowed provider always keeps at least one slot per day. */
	minimumProviderCap: 1,
	/**
	 * Volume-pressure verdicts recorded for this provider SO FAR TODAY (the
	 * cumulative count in the daily stats hash, not a consecutive run) that
	 * force a tighten on their own.
	 */
	dailyPressureEventsForTighten: 3,
	/** Volume-pressure counters expire; pressure is a recent-history signal. */
	pressureTtlSeconds: 6 * 60 * 60,
	/**
	 * D10 — minimum sample. Below this many sends in the window the gate returns
	 * `insufficient_data` and NOTHING moves: a single bounce must never be able
	 * to halve a provider's cap, and a single clean message must never widen it.
	 * Chosen so one bounce (2%) stays under the 3% deceleration threshold while
	 * still being reachable inside a day-1 cap of 50.
	 */
	minimumSampleSends: 50,
	/**
	 * D9 — AIMD asymmetry. Retreat is instant; advance costs this many
	 * CONSECUTIVE clean, minimum-sample days.
	 */
	cleanDaysForRecovery: 3,
	/** Decimal places a persisted multiplier is rounded to at the write boundary. */
	capMultiplierPrecision: 2,
	/** Deferral-aware retry: backoff factor is capped so retries never stall. */
	maximumBackoffFactor: 8,
	/** Absolute ceiling for a pressure-lengthened retry delay. */
	maximumPressureRetryDelayMs: 4 * 60 * 60 * 1000,
});

/**
 * Classifier verdicts that mean "this provider is signalling volume pressure".
 *
 * Greylisting is deliberately excluded: it is a per-message challenge, not a
 * statement about our sending volume, and treating it as pressure would tighten
 * caps for every well-behaved greylisting receiver.
 */
const VOLUME_PRESSURE_CATEGORIES: ReadonlySet<SmtpFailureCategory> = new Set<SmtpFailureCategory>([
	'rate_limited',
	'gmail_rate_limited',
	'yahoo_ts03',
	'yahoo_tss04',
	'microsoft_resource_throttle',
]);

export function isVolumePressureCategory(category: SmtpFailureCategory): boolean {
	return VOLUME_PRESSURE_CATEGORIES.has(category);
}

/** Coerce an arbitrary persisted/observed counter into a safe non-negative int. */
export function sanitizeCount(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.floor(parsed);
}

/**
 * Coerce a persisted cap multiplier into the policy domain.
 *
 * Anything unparseable (missing key, `NaN`, a hand-edited value out of range)
 * falls back to the unrestricted default so a corrupt provider row can never
 * silently strangle a provider.
 */
export function normalizeCapMultiplier(raw: unknown): number {
	if (raw === null || raw === undefined || raw === '') {
		return PROVIDER_WARMING_POLICY.defaultCapMultiplier;
	}
	const parsed = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(parsed)) return PROVIDER_WARMING_POLICY.defaultCapMultiplier;
	if (parsed >= PROVIDER_WARMING_POLICY.defaultCapMultiplier) {
		return PROVIDER_WARMING_POLICY.defaultCapMultiplier;
	}
	if (parsed <= PROVIDER_WARMING_POLICY.minimumCapMultiplier) {
		return PROVIDER_WARMING_POLICY.minimumCapMultiplier;
	}
	// Round HERE, at the single boundary every multiplier passes through before
	// it is persisted or compared. `0.25 + 0.1` is `0.35000000000000003`; twenty
	// promotions of an unrounded value drift, and the drifted value is then
	// compared with `!==` against the value Redis holds.
	return roundCapMultiplier(parsed);
}

/** Fixed-precision rounding for a value in the multiplier domain. */
function roundCapMultiplier(value: number): number {
	const scale = 10 ** PROVIDER_WARMING_POLICY.capMultiplierPrecision;
	return Math.round(value * scale) / scale;
}

/**
 * The per-provider daily cap derived from the authoritative per-IP cap.
 *
 * A graduated (uncapped) IP stays uncapped for every provider: warming has
 * ended, and this module never invents a cap the schedule does not impose.
 */
export function effectiveProviderCap(dailyCap: number, capMultiplier: number): number {
	if (!Number.isFinite(dailyCap)) return Infinity;
	const multiplier = normalizeCapMultiplier(capMultiplier);
	if (multiplier >= PROVIDER_WARMING_POLICY.defaultCapMultiplier) return dailyCap;
	return Math.max(
		PROVIDER_WARMING_POLICY.minimumProviderCap,
		Math.min(dailyCap, Math.floor(dailyCap * multiplier))
	);
}

/** One provider's measured window, as recorded in its daily stats hash. */
export interface ProviderWarmingWindow {
	readonly sent: number;
	readonly bounced: number;
	readonly deferred: number;
	/** Cumulative volume-pressure verdicts recorded for this provider TODAY. */
	readonly pressureEventsToday: number;
}

/**
 * Gate 2's verdict, as a discriminated union: a rate that was never computed
 * cannot be read. `insufficient_data` carries the sample it had and the sample
 * it needed instead of two meaningless zeroes.
 */
export type ProviderCapDecision =
	| {
			readonly verdict: 'insufficient_data';
			readonly capMultiplier: number;
			readonly cleanStreak: number;
			readonly have: number;
			readonly need: number;
	  }
	| {
			readonly verdict: 'tighten' | 'recover' | 'hold';
			readonly capMultiplier: number;
			readonly cleanStreak: number;
			readonly bounceRate: number;
			readonly deferralRate: number;
	  };

export type ProviderCapVerdict = ProviderCapDecision['verdict'];

/**
 * Gate 2 for the provider dimension: the shipped deceleration/acceleration
 * thresholds, evaluated on this provider's own outcomes plus the per-ISP
 * volume-pressure verdicts the SMTP classifier produced.
 *
 * The AIMD asymmetry of D9/D10 is enforced here, not by the caller:
 *  - below `minimumSampleSends` the verdict is `insufficient_data` and NOTHING
 *    moves — the ratios are not even computed;
 *  - a breach tightens x0.5 immediately and resets the clean streak;
 *  - a clean day only INCREMENTS the streak; recovery costs
 *    `cleanDaysForRecovery` consecutive clean, minimum-sample days.
 */
export function nextProviderCapMultiplier(
	currentMultiplier: number,
	window: ProviderWarmingWindow,
	cleanStreak = 0
): ProviderCapDecision {
	const current = normalizeCapMultiplier(currentMultiplier);
	const streak = sanitizeCount(cleanStreak);
	const sent = sanitizeCount(window.sent);
	const need = PROVIDER_WARMING_POLICY.minimumSampleSends;
	if (sent < need) {
		return {
			verdict: 'insufficient_data',
			capMultiplier: current,
			cleanStreak: streak,
			have: sent,
			need,
		};
	}

	const pressureEvents = sanitizeCount(window.pressureEventsToday);
	const bounceRate = sanitizeCount(window.bounced) / sent;
	const deferralRate = sanitizeCount(window.deferred) / sent;

	if (
		bounceRate > ADAPTIVE_WARMING_POLICY.deceleration.bounceRateExclusiveMin ||
		deferralRate > ADAPTIVE_WARMING_POLICY.deceleration.deferralRateExclusiveMin ||
		pressureEvents >= PROVIDER_WARMING_POLICY.dailyPressureEventsForTighten
	) {
		return {
			verdict: 'tighten',
			capMultiplier: normalizeCapMultiplier(current * PROVIDER_WARMING_POLICY.tightenMultiplier),
			cleanStreak: 0,
			bounceRate,
			deferralRate,
		};
	}

	const clean =
		pressureEvents === 0 &&
		bounceRate < ADAPTIVE_WARMING_POLICY.acceleration.bounceRateExclusiveMax &&
		deferralRate < ADAPTIVE_WARMING_POLICY.acceleration.deferralRateExclusiveMax;
	if (!clean) {
		// Between the acceleration and deceleration thresholds: no retreat, but
		// the run of clean days is broken.
		return { verdict: 'hold', capMultiplier: current, cleanStreak: 0, bounceRate, deferralRate };
	}

	const nextStreak = streak + 1;
	if (current >= PROVIDER_WARMING_POLICY.defaultCapMultiplier) {
		// Already unrestricted — there is nothing to recover, and the streak is
		// meaningless until a tighten resets it.
		return { verdict: 'hold', capMultiplier: current, cleanStreak: 0, bounceRate, deferralRate };
	}
	if (nextStreak < PROVIDER_WARMING_POLICY.cleanDaysForRecovery) {
		return {
			verdict: 'hold',
			capMultiplier: current,
			cleanStreak: nextStreak,
			bounceRate,
			deferralRate,
		};
	}
	return {
		verdict: 'recover',
		capMultiplier: normalizeCapMultiplier(current + PROVIDER_WARMING_POLICY.recoveryStep),
		cleanStreak: 0,
		bounceRate,
		deferralRate,
	};
}

/**
 * Deferral-aware retry: lengthen the classifier's suggested backoff while the
 * destination provider is signalling volume pressure on this IP.
 *
 * Doubling per recent pressure event, capped, so a provider that is telling us
 * to slow down is not hammered by the retry stream that provoked it.
 */
export function pressureAdjustedDelayMs(baseDelayMs: number, pressureEvents: number): number {
	const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
	const events = sanitizeCount(pressureEvents);
	if (base === 0 || events === 0) return base;
	const factor = Math.min(2 ** events, PROVIDER_WARMING_POLICY.maximumBackoffFactor);
	return Math.min(Math.round(base * factor), PROVIDER_WARMING_POLICY.maximumPressureRetryDelayMs);
}
