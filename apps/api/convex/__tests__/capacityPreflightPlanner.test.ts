/**
 * The pure planner half of the pre-flight capacity gate: the planner-verdict
 * mapping (`toAssessment`), the counted-plan rule that a stopped count never
 * licenses "it fits", the quoted refusal schedule the operator reads, the
 * audience-count ceiling, and the one-sentence schedule description.
 */

import { describe, it, expect, vi } from 'vitest';
import { DAY_MS, MIDNIGHT, useMtaPreflightEnv } from './preflightFixtures';
import { describeCapacitySchedule } from '../campaigns/preflight';
import { MAX_PLAN_DAYS } from '../campaigns/capacityPlan';
import {
	assessCountedPlan,
	audienceCountCeiling,
	quotedRefusalSchedule,
	toAssessment,
} from '../campaigns/capacityPreflight';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock, MOCK_SINGLETON_ORG } = await import('./sessionOrganizationMock');
	return {
		...(await sessionOrganizationMock()),
		// The ramp cells the `adaptive_mix` suite seeds belong to a tenant, and the
		// warming-cap gate resolves it exactly the way the dispatch path does.
		getSingletonOrganizationId: vi.fn().mockResolvedValue(MOCK_SINGLETON_ORG),
	};
});

useMtaPreflightEnv();

describe('toAssessment — the planner-verdict mapping', () => {
	it('treats the days === 0 sentinel as UNKNOWN capacity and allows the send', () => {
		expect(
			toAssessment({
				fits: false,
				days: 0,
				slices: [],
				finishesAt: MIDNIGHT,
				covered: 0,
				truncated: false,
				audienceUnderCounted: false,
			})
		).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'unplannable_projection',
		});
	});

	it('passes a real schedule through as a measured refusal', () => {
		expect(
			toAssessment({
				fits: false,
				days: 2,
				slices: [100, 50],
				finishesAt: MIDNIGHT + 2 * DAY_MS,
				covered: 150,
				truncated: false,
				audienceUnderCounted: false,
			})
		).toEqual({
			capacityKnown: true,
			fits: false,
			schedule: {
				fits: false,
				days: 2,
				slices: [100, 50],
				finishesAt: MIDNIGHT + 2 * DAY_MS,
				covered: 150,
				truncated: false,
				audienceUnderCounted: false,
			},
		});
	});

	it('reports a fitting plan as measured', () => {
		expect(toAssessment({ fits: true })).toEqual({ capacityKnown: true, fits: true });
	});

	/**
	 * An under-counted audience is its OWN fact, not a truncated plan. Folding
	 * the two made a five-day schedule render as "more than 60 days" (D14).
	 */
	it('marks an under-counted audience without forging a truncated plan', () => {
		const plan = {
			fits: false as const,
			days: 5,
			slices: [0, 100, 200, 200, 100],
			finishesAt: MIDNIGHT + 5 * DAY_MS,
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		};

		const assessment = toAssessment(plan, { audienceUnderCounted: true });

		expect(assessment.fits).toBe(false);
		if (assessment.fits) return;
		expect(assessment.schedule.audienceUnderCounted).toBe(true);
		expect(assessment.schedule.truncated).toBe(false);
		expect(describeCapacitySchedule(assessment.schedule)).toContain('at least 5 days');
	});
});

/**
 * THE COUNT-COMPLETENESS RULE, pinned where it is reachable.
 *
 * A count that stopped short is "at least N", and N fitting says nothing about
 * the audience behind it — so it may license a REFUSAL (the real audience is only
 * bigger) and never an approval. The binding path cannot seed the case: the
 * candidate ceiling is 25,001 recipients under a 2% own-arm share and the
 * document budget stops the scan thousands of rows before that, so the rule is
 * pinned on the pure helper the gate decides through (as `toAssessment` is).
 */
describe('assessCountedPlan — a stopped count never licenses "it fits"', () => {
	const refusal = {
		fits: false as const,
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: MIDNIGHT + 5 * DAY_MS,
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};

	it('measures a fitting plan when the count ran to the end', () => {
		expect(assessCountedPlan({ fits: true }, { completeness: 'exact' })).toEqual({
			capacityKnown: true,
			fits: true,
		});
	});

	/**
	 * 25,000 counted recipients at a 2% own-arm share are 500 messages, which fits
	 * a 500-message horizon — while the audience behind the ceiling can be
	 * millions of contacts whose own-arm tail expires in the queue. That is the
	 * P0-5 failure itself, dressed as a measurement.
	 */
	it('holds a fitting plan built from a CAPPED count as unmeasured', () => {
		expect(assessCountedPlan({ fits: true }, { completeness: 'candidate_capped' })).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'audience_under_counted',
		});
	});

	it('holds a fitting plan built from a budget-stopped count as unmeasured', () => {
		expect(assessCountedPlan({ fits: true }, { completeness: 'read_budget_exhausted' })).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'audience_under_counted',
		});
	});

	it('still REFUSES on a capped count, and marks the plan as a lower bound', () => {
		const assessment = assessCountedPlan(refusal, { completeness: 'candidate_capped' });

		expect(assessment.fits).toBe(false);
		if (assessment.fits) return;
		expect(assessment.schedule.audienceUnderCounted).toBe(true);
		expect(describeCapacitySchedule(assessment.schedule)).toContain('at least 5 days');
	});

	/**
	 * An exact count hedges NOTHING here. Own-arm bounds that differ used to add a
	 * hedge at this seam; they no longer can, because the schedule this helper
	 * returns is the DECISION's — enumerated in own-arm messages — and never the
	 * one the operator reads (`quotedRefusalSchedule`).
	 */
	it('leaves an exactly counted refusal unhedged', () => {
		const assessment = assessCountedPlan(refusal, { completeness: 'exact' });

		expect(assessment.fits).toBe(false);
		if (assessment.fits) return;
		expect(assessment.schedule.audienceUnderCounted).toBe(false);
	});
});

/**
 * THE REFUSAL IS DECIDED IN MESSAGES AND QUOTED IN RECIPIENTS.
 *
 * Only own-MTA volume meets the warming cap, so `share x audience` is what can
 * prove a campaign's tail expires — and it is not a schedule anyone runs. The
 * walker paces the WHOLE audience through the same day budget, so a plan
 * enumerated over own-arm messages quotes roughly `share` of the days the send
 * takes and prints message counts under a "recipients" label.
 */
describe('quotedRefusalSchedule — the plan the operator reads is the walk', () => {
	/** 300 own-arm messages of a 600-recipient audience at a half share. */
	const ownArmSchedule = {
		fits: false as const,
		days: 3,
		slices: [0, 100, 200],
		finishesAt: MIDNIGHT + 3 * DAY_MS,
		covered: 300,
		truncated: false,
		audienceUnderCounted: false,
	};
	/** The same audience as the walker meters it: all 600 recipients. */
	const walkerSchedule = {
		fits: false as const,
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: MIDNIGHT + 5 * DAY_MS,
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};

	it('quotes the walker plan, in recipients, not the own-arm message plan', () => {
		expect(
			quotedRefusalSchedule({ ownArmSchedule, walkerSchedule, audienceUnderCounted: false })
		).toEqual(walkerSchedule);
		expect(
			describeCapacitySchedule(
				quotedRefusalSchedule({ ownArmSchedule, walkerSchedule, audienceUnderCounted: false })
			)
		).toContain('about 5 days');
	});

	it('carries the count hedge onto the quoted plan', () => {
		const schedule = quotedRefusalSchedule({
			ownArmSchedule,
			walkerSchedule,
			audienceUnderCounted: true,
		});

		expect(schedule.covered).toBe(600);
		expect(schedule.audienceUnderCounted).toBe(true);
		expect(describeCapacitySchedule(schedule)).toContain('at least 5 days');
	});

	/**
	 * A projection that plateaus at zero can cover the own arm's share and still
	 * reach nobody else: the walker's plan is then the `days === 0` sentinel, which
	 * callers must never render as a finish. The proven refusal stands on the
	 * own-arm plan — quoted as the lower bound it is, never as a finish date.
	 */
	it('falls back to the own-arm plan, hedged, when the walk cannot be planned', () => {
		const unplannable = {
			fits: false as const,
			days: 0,
			slices: [],
			finishesAt: MIDNIGHT,
			covered: 0,
			truncated: false,
			audienceUnderCounted: false,
		};

		const schedule = quotedRefusalSchedule({
			ownArmSchedule,
			walkerSchedule: unplannable,
			audienceUnderCounted: false,
		});

		expect(schedule.days).toBe(3);
		expect(schedule.audienceUnderCounted).toBe(true);
		expect(describeCapacitySchedule(schedule)).toContain('at least 3 days');
	});
});

describe('audienceCountCeiling — counting far enough to keep the refusal available', () => {
	it('stops one recipient past everything the plan window could carry', () => {
		expect(audienceCountCeiling(500, { floor: 1, peak: 1 })).toBe(501);
	});

	/**
	 * Own-arm volume is `share x recipients`, so 500 of capacity takes 25,050
	 * recipients to exceed at a 2% floor. Counting to 501 instead would stop while
	 * the verdict is still undecided and answer "unmeasured" where a refusal was
	 * available.
	 */
	it('counts 1/share as many recipients when the own arm carries a fraction', () => {
		expect(audienceCountCeiling(500, { floor: 0.02, peak: 0.5 })).toBe(25_050);
	});

	/**
	 * A zero lower bound exceeds no capacity, so the floor sets no threshold at
	 * all; the peak's is the point past which more recipients cannot change the
	 * answer either way.
	 */
	it('falls back to the PEAK when the floor is zero', () => {
		expect(audienceCountCeiling(500, { floor: 0, peak: 0.5 })).toBe(1_002);
	});
});

describe('describeCapacitySchedule — one sentence per state of knowledge', () => {
	const base = {
		fits: false as const,
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: MIDNIGHT + 5 * DAY_MS,
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};

	it('quotes the finish date only when both facts are known', () => {
		expect(describeCapacitySchedule(base)).toContain('about 5 days');
	});

	it('says "at least" when the audience is only a lower bound', () => {
		expect(describeCapacitySchedule({ ...base, audienceUnderCounted: true })).toContain(
			'at least 5 days'
		);
	});

	it('says "more than 60 days" only when the enumeration itself truncated', () => {
		expect(describeCapacitySchedule({ ...base, days: MAX_PLAN_DAYS, truncated: true })).toContain(
			`more than ${MAX_PLAN_DAYS} days`
		);
	});
});
