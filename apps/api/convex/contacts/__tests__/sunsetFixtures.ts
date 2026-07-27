/**
 * Shared fixture builders for the sunset-policy suites (deliverability plan
 * P4-4). Kept in one place so the pure suites, the safety suite and the
 * integration suites all describe a contact the same way — a divergent fixture
 * is how a safety property quietly stops being tested.
 */

import { SUNSET_POLICY_DEFAULTS, type SunsetFacts, type SunsetPolicy } from '../sunsetPolicy';

export const DAY = 86_400_000;

/** A fixed, sane "now" so no suite depends on the wall clock. */
export const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

export function daysAgo(days: number, now: number = NOW): number {
	return now - days * DAY;
}

/**
 * A contact that is measurable and long-tenured but has never engaged. Every
 * fixture below is this one with a field changed, so a test's intent is exactly
 * its override list.
 */
export function facts(overrides: Partial<SunsetFacts> = {}): SunsetFacts {
	return {
		now: NOW,
		createdAt: daysAgo(400),
		firstMessagedAt: daysAgo(380),
		hasSendHistory: true,
		hasEmail: true,
		isGloballyUnsubscribed: false,
		isAlreadySuppressed: false,
		isExempt: false,
		stage: 'engaged',
		...overrides,
	};
}

export function policy(overrides: Partial<SunsetPolicy> = {}): SunsetPolicy {
	return { ...SUNSET_POLICY_DEFAULTS, ...overrides };
}
