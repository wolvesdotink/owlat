/**
 * CROSSING THE 0.5 CEILING (plan D3) — the either/or, exhaustively.
 *
 * Each of the four standalone conditions is failed on its own to prove it is
 * load-bearing, then all four are met together to prove they are sufficient. The
 * DNSBL streak gets its own group because "14 CONSECUTIVE days" is the condition
 * most easily implemented as "14 clean days somewhere in the window", which is a
 * different and much weaker promise.
 */

import { describe, expect, it } from 'vitest';
import {
	derivePromotionConditions,
	dnsblCleanStreakDays,
	evaluatePhasePromotion,
	isDnsblObservationCurrent,
	PROMOTION_BASE_DWELL_MS,
	PROMOTION_DNSBL_CLEAN_DAYS,
	PROMOTION_STANDALONE_DWELL_MULTIPLE,
	type DnsblDayObservation,
	type RampPromotionEvidence,
} from '../phasePromotion';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function cleanDays(count: number, dirtyIndex?: number): DnsblDayObservation[] {
	const days: DnsblDayObservation[] = [];
	const today = Math.floor(NOW / DAY_MS) * DAY_MS;
	for (let index = 0; index < count; index += 1) {
		days.push({ dayStart: today - index * DAY_MS, clean: index !== dirtyIndex });
	}
	return days;
}

/** Every standalone condition met; no external reading at all. */
function standaloneEvidence(overrides: Partial<RampPromotionEvidence> = {}): RampPromotionEvidence {
	return {
		googleCompliancePassAt: null,
		sndsBandGreenAt: null,
		seedProbePassAt: NOW - 2 * DAY_MS,
		ceilingHeldMs: PROMOTION_BASE_DWELL_MS * PROMOTION_STANDALONE_DWELL_MULTIPLE,
		requiredDwellMs: PROMOTION_BASE_DWELL_MS,
		dnsblDays: cleanDays(PROMOTION_DNSBL_CLEAN_DAYS + 2),
		worstCellDeferralRate: 0.02,
		deferralMax: 0.1,
		...overrides,
	};
}

describe('below the 0.5 line no evidence is required', () => {
	it('promotes to 0.5 with no reading of any kind', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.5,
			provider: 'gmail',
			evidence: standaloneEvidence({
				seedProbePassAt: null,
				ceilingHeldMs: null,
				dnsblDays: [],
				worstCellDeferralRate: null,
			}),
			now: NOW,
		});
		expect(decision.allowed).toBe(true);
		expect(decision.evidenceRequired).toBe(false);
		expect(decision.viaRoute).toBeNull();
	});
});

describe('the external routes', () => {
	it('a Google Compliance pass within 7 days carries the gmail cell alone', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.8,
			provider: 'gmail',
			evidence: standaloneEvidence({
				googleCompliancePassAt: NOW - 3 * DAY_MS,
				seedProbePassAt: null,
				ceilingHeldMs: null,
				dnsblDays: [],
				worstCellDeferralRate: null,
			}),
			now: NOW,
		});
		expect(decision.allowed).toBe(true);
		expect(decision.viaRoute).toBe('google_compliance');
	});

	it('a pass older than 7 days does not', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.8,
			provider: 'gmail',
			evidence: standaloneEvidence({
				googleCompliancePassAt: NOW - 8 * DAY_MS,
				seedProbePassAt: null,
				ceilingHeldMs: null,
				dnsblDays: [],
				worstCellDeferralRate: null,
			}),
			now: NOW,
		});
		expect(decision.allowed).toBe(false);
	});

	it('a green SNDS band carries the microsoft cell — and only that cell', () => {
		const evidence = standaloneEvidence({
			sndsBandGreenAt: NOW - DAY_MS,
			seedProbePassAt: null,
			ceilingHeldMs: null,
			dnsblDays: [],
			worstCellDeferralRate: null,
		});
		expect(
			evaluatePhasePromotion({ targetCeiling: 0.8, provider: 'microsoft', evidence, now: NOW })
				.viaRoute
		).toBe('snds_band');
		expect(
			evaluatePhasePromotion({ targetCeiling: 0.8, provider: 'yahoo', evidence, now: NOW }).allowed
		).toBe(false);
	});

	it('evidence dated in the future is not evidence', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.8,
			provider: 'gmail',
			evidence: standaloneEvidence({
				googleCompliancePassAt: NOW + DAY_MS,
				seedProbePassAt: null,
				ceilingHeldMs: null,
				dnsblDays: [],
				worstCellDeferralRate: null,
			}),
			now: NOW,
		});
		expect(decision.allowed).toBe(false);
	});
});

describe('the standalone route needs all four conditions', () => {
	it('passes with all four met, on a provider with no external route at all', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.8,
			provider: 'apple',
			evidence: standaloneEvidence(),
			now: NOW,
		});
		expect(decision.allowed).toBe(true);
		expect(decision.viaRoute).toBe('standalone_corroboration');
	});

	const failures: readonly {
		readonly name: string;
		readonly override: Partial<RampPromotionEvidence>;
		readonly condition: string;
	}[] = [
		{
			name: 'the doubled dwell has not been served',
			override: { ceilingHeldMs: PROMOTION_BASE_DWELL_MS },
			condition: 'dwell_multiple_served',
		},
		{
			name: 'the dwell is unmeasured',
			override: { ceilingHeldMs: null },
			condition: 'dwell_multiple_served',
		},
		{
			name: 'no seed probe passed within 7 days',
			override: { seedProbePassAt: NOW - 9 * DAY_MS },
			condition: 'seed_probe_pass_recent',
		},
		{
			name: 'the DNSBL streak is short',
			override: { dnsblDays: cleanDays(PROMOTION_DNSBL_CLEAN_DAYS + 2, 3) },
			condition: 'dnsbl_clean_streak',
		},
		{
			name: 'another cell is deferring above the threshold',
			override: { worstCellDeferralRate: 0.2 },
			condition: 'deferral_under_threshold_all_cells',
		},
	];

	for (const failure of failures) {
		it(`refuses when ${failure.name}`, () => {
			const decision = evaluatePhasePromotion({
				targetCeiling: 0.8,
				provider: 'apple',
				evidence: standaloneEvidence(failure.override),
				now: NOW,
			});
			expect(decision.allowed).toBe(false);
			const outstanding = decision.routes.flatMap((route) =>
				route.outstanding.map((entry) => entry.condition)
			);
			expect(outstanding).toContain(failure.condition);
		});
	}

	it('reports an unmeasurable condition as unknown, never as met', () => {
		const conditions = derivePromotionConditions(
			standaloneEvidence({ worstCellDeferralRate: null, ceilingHeldMs: Number.NaN }),
			NOW
		);
		expect(conditions.deferral_under_threshold_all_cells).toBe('unknown');
		expect(conditions.dwell_multiple_served).toBe('unknown');
	});
});

describe('the DNSBL streak is CONSECUTIVE', () => {
	it('counts an unbroken run ending at the most recent day', () => {
		expect(dnsblCleanStreakDays(cleanDays(14))).toBe(14);
	});

	it('resets on ONE dirty day, however clean the rest of the window is', () => {
		expect(dnsblCleanStreakDays(cleanDays(30, 5))).toBe(5);
		expect(dnsblCleanStreakDays(cleanDays(30, 0))).toBe(0);
	});

	it('resets on a GAP — a streak assembled from unobserved days is not a streak', () => {
		const today = Math.floor(NOW / DAY_MS) * DAY_MS;
		const withGap: DnsblDayObservation[] = [
			{ dayStart: today, clean: true },
			{ dayStart: today - DAY_MS, clean: true },
			{ dayStart: today - 3 * DAY_MS, clean: true },
			{ dayStart: today - 4 * DAY_MS, clean: true },
		];
		expect(dnsblCleanStreakDays(withGap)).toBe(2);
	});

	it('treats thin coverage as unknown rather than as a short streak', () => {
		const conditions = derivePromotionConditions(
			standaloneEvidence({ dnsblDays: cleanDays(PROMOTION_DNSBL_CLEAN_DAYS - 1) }),
			NOW
		);
		expect(conditions.dnsbl_clean_streak).toBe('unknown');
	});

	it('is empty-safe', () => {
		expect(dnsblCleanStreakDays([])).toBe(0);
	});
});

/**
 * A STREAK MUST REACH THE PRESENT.
 *
 * Fourteen consecutive clean days that ENDED last week is the exact shape a
 * controller that stopped ticking leaves behind — a deployment offline, a paused
 * cron, a truncated scan. Counting it as met would unlock the most expensive
 * rung on the ladder on evidence nobody has gathered since.
 */
describe('the DNSBL streak must be a reading of the PRESENT', () => {
	function runEndingDaysAgo(daysAgo: number): DnsblDayObservation[] {
		const today = Math.floor(NOW / DAY_MS) * DAY_MS;
		const days: DnsblDayObservation[] = [];
		for (let index = 0; index < PROMOTION_DNSBL_CLEAN_DAYS + 2; index += 1) {
			days.push({ dayStart: today - (daysAgo + index) * DAY_MS, clean: true });
		}
		return days;
	}

	it('accepts a run ending today', () => {
		const conditions = derivePromotionConditions(
			standaloneEvidence({ dnsblDays: runEndingDaysAgo(0) }),
			NOW
		);
		expect(conditions.dnsbl_clean_streak).toBe('met');
	});

	it('accepts a run ending yesterday — the newest COMPLETE day', () => {
		const conditions = derivePromotionConditions(
			standaloneEvidence({ dnsblDays: runEndingDaysAgo(1) }),
			NOW
		);
		expect(conditions.dnsbl_clean_streak).toBe('met');
	});

	it('rejects a fourteen-day clean run that ended a week ago', () => {
		const conditions = derivePromotionConditions(
			standaloneEvidence({ dnsblDays: runEndingDaysAgo(7) }),
			NOW
		);
		expect(conditions.dnsbl_clean_streak).toBe('unknown');
	});

	it('refuses the whole standalone route on stale streak evidence', () => {
		const decision = evaluatePhasePromotion({
			targetCeiling: 0.8,
			provider: 'yahoo',
			evidence: standaloneEvidence({ dnsblDays: runEndingDaysAgo(7) }),
			now: NOW,
		});
		expect(decision.allowed).toBe(false);
		expect(decision.routes[0]?.outstanding.map((entry) => entry.condition)).toContain(
			'dnsbl_clean_streak'
		);
	});

	it('is not fooled by a stray future-dated observation', () => {
		const today = Math.floor(NOW / DAY_MS) * DAY_MS;
		expect(isDnsblObservationCurrent([{ dayStart: today - 30 * DAY_MS, clean: true }], NOW)).toBe(
			false
		);
		expect(isDnsblObservationCurrent([], NOW)).toBe(false);
		expect(isDnsblObservationCurrent([{ dayStart: today, clean: true }], Number.NaN)).toBe(false);
	});
});

/**
 * ADVERSARIAL: DEGENERATE INPUTS MUST FAIL CLOSED.
 *
 * This function's exported contract IS the gate. A caller that hands it a rung
 * or a dwell it cannot read must get a refusal, never a promotion — "we could
 * not tell" is the one answer that must never be spelled `allowed: true`.
 */
describe('degenerate inputs never open the gate', () => {
	for (const targetCeiling of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		it(`refuses a target ceiling of ${String(targetCeiling)}`, () => {
			const decision = evaluatePhasePromotion({
				targetCeiling,
				provider: 'gmail',
				// Every condition met: only the unreadable target may stop this.
				evidence: standaloneEvidence({ googleCompliancePassAt: NOW - DAY_MS }),
				now: NOW,
			});
			expect(decision.allowed).toBe(false);
			expect(decision.viaRoute).toBeNull();
			expect(decision.evidenceRequired).toBe(true);
			// The routes still travel back, so a screen can say what it looked at.
			expect(decision.routes.length).toBeGreaterThan(0);
		});
	}

	for (const requiredDwellMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
		it(`reports the dwell as unknown for a required dwell of ${String(requiredDwellMs)}`, () => {
			const conditions = derivePromotionConditions(standaloneEvidence({ requiredDwellMs }), NOW);
			expect(conditions.dwell_multiple_served).toBe('unknown');
		});
	}

	it('reports the dwell as unknown for a degenerate held duration', () => {
		expect(
			derivePromotionConditions(standaloneEvidence({ ceilingHeldMs: Number.NaN }), NOW)
				.dwell_multiple_served
		).toBe('unknown');
	});
});
