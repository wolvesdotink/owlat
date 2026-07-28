/**
 * Shared fixture builders for the sunset-policy suites (deliverability plan
 * P4-4). Kept in one place so the pure suites, the safety suite and the
 * integration suites all describe a contact the same way — a divergent fixture
 * is how a safety property quietly stops being tested.
 */

import { convexTest } from 'convex-test';
import schema from '../../schema';
import {
	SUNSET_POLICY_DEFAULTS,
	type SunsetFacts,
	type SunsetMeasuredVerdict,
	type SunsetPolicy,
	type SunsetVerdict,
} from '../sunsetPolicy';

/**
 * The convex-test module map. `convex-test` needs every function module the
 * harness might reach, and a `__tests__` directory sits one level deeper than
 * the functions it tests, so the contacts glob is rewritten back onto the
 * convex root before being merged with it.
 *
 * It lives here rather than in each suite because five suites had a byte-identical
 * copy of it — and a module map that drifts between suites is how one suite
 * quietly stops exercising the code the others do.
 */
const rootGlob = import.meta.glob('../../**/*.*s');
const contactsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../contacts/'),
		mod,
	])
);
export const modules = { ...rootGlob, ...contactsGlob };

/** A convex-test instance over the real schema and the map above. */
export function harness() {
	return convexTest(schema, modules);
}

export type Harness = ReturnType<typeof harness>;

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

/**
 * Narrow a verdict to the measured arm, failing loudly if the engine held. The
 * verdict union carries day counts only where they are real, so a test that
 * wants a number has to say which arm it expected — which is the point of the
 * union, and why no `?? 0` appears in any of these suites.
 */
export function measured(verdict: SunsetVerdict): SunsetMeasuredVerdict {
	if (verdict.action === 'hold') {
		throw new Error(`expected a measured verdict, got hold (${verdict.reason})`);
	}
	return verdict;
}
