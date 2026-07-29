/**
 * ONE SENTENCE PER PACE RUNG (plan D12).
 *
 * `describePaceDecision` is exhaustive over `PaceDecisionReason` so a new rung
 * cannot ship without a sentence — but exhaustiveness is a COMPILE-time
 * property, and only about five of its twenty arms are reachable through
 * `paceDecisionAdminNotice` (the notice fires on a named cause that also changed
 * something). Everything else — the holds, the idempotency guard, the interlock,
 * the one sanctioned utilisation change, the share-only group — would ship with
 * no assertion at all.
 *
 * This is that assertion, table-driven, the same shape
 * `delivery/__tests__/mixDecisions.test.ts` gives `describeRampDecision`. Every
 * reason in the union gets a row; the table is checked against the union itself
 * so an added rung fails HERE rather than shipping unread.
 */

import { describe, expect, it } from 'vitest';
import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import { describePaceDecision, paceDecisionAdminNotice } from '../controllerNarrative';
import type { PaceDecision, PaceDecisionReason } from '../paceTypes';

const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };

function decision(overrides: Partial<PaceDecision> & { reason: PaceDecisionReason }): PaceDecision {
	return {
		multiplier: 1,
		fromMultiplier: 1,
		direction: 'hold',
		verdict: 'not_evaluated',
		failedGate: undefined,
		freeze: undefined,
		cleanStreak: 0,
		countedUtcDay: undefined,
		...overrides,
	};
}

/**
 * EVERY reason in `PaceDecisionReason`, with the words its sentence has to
 * contain. A `Record` keyed by the union rather than an array, so a NEW rung
 * fails to compile here instead of shipping with no assertion — the same
 * guarantee the switch itself has, on the fixture side.
 *
 * The expectations are the OPERATOR-FACING facts — what the dial did and why —
 * never the whole sentence: pinning the prose verbatim makes the fixture a copy
 * of the implementation and turns a wording fix into a red test. An empty list
 * means "any sentence, as long as it names the cell", which is asserted for
 * every row.
 */
const REASONS: Record<PaceDecisionReason, readonly string[]> = {
	kill_switch: ['kill switch'],
	clock_unusable: ['clock'],
	abuse_status: [],
	breaker: [],
	dnsbl: [],
	frozen: [],
	freeze_unreadable: [],
	holding: [],
	evidence_stale: [],
	awaiting_corroboration: [],
	capacity_unknown: [],
	window_open: [],
	building_confidence: [],
	capacity_ceiling: [],
	phase_ceiling: [],
	degradation_ceiling: [],
	share_unreadable: [],
	healthy: [],
	graduated: [],
	// SHARE-ONLY RUNGS the pace dial cannot reach (P3-6's operator controls
	// rewrite a share decision, and the pace ladder is never handed one).
	// Listed so the Record stays exhaustive: the compile error these four
	// caused is the guarantee this fixture exists to provide.
	operator_pause: [],
	operator_pin: [],
	operator_force_advance: [],
	operator_phase_reset: [],
	low_utilisation: [],
	day_already_advanced: [],
	share_moved_first: [],
	multiplier_unreadable: [],
	schedule_ceiling: [],
	hard_bounce: ['hard bounce'],
	deferral: ['deferral'],
	complaint: ['complaint'],
	engagement_ratio: ['engagement ratio'],
	seed_placement: ['seed placement'],
};

describe('every pace rung has a sentence', () => {
	it.each(Object.entries(REASONS))('%s reads as an operator sentence', (reason, contains) => {
		const sentence = describePaceDecision(CELL, decision({ reason: reason as PaceDecisionReason }));
		expect(sentence.length).toBeGreaterThan(0);
		// Named, so an operator reading the audit trail knows WHICH cell moved.
		expect(sentence).toContain('campaign mail to gmail');
		for (const fragment of contains) expect(sentence.toLowerCase()).toContain(fragment);
	});
});

describe('the gate rungs read differently up and down', () => {
	it('a retreat says what it cost, a floor hold says the dial is already there', () => {
		const retreat = describePaceDecision(
			CELL,
			decision({ reason: 'complaint', direction: 'decrease', fromMultiplier: 1, multiplier: 0.5 })
		);
		expect(retreat).toContain('1.00x -> 0.50x');

		const floored = describePaceDecision(
			CELL,
			decision({ reason: 'complaint', direction: 'hold', fromMultiplier: 0.25, multiplier: 0.25 })
		);
		// A breach on a dial already at its minimum is not a no-op, and the sentence
		// must not read like one.
		expect(floored).toContain('minimum');
	});

	it('renders a multiplier as a MULTIPLIER, never as a percentage', () => {
		const sentence = describePaceDecision(
			CELL,
			decision({ reason: 'holding', fromMultiplier: 0.5, multiplier: 0.5 })
		);
		expect(sentence).toContain('0.50x');
		expect(sentence).not.toContain('50%');
	});
});

describe('the admin notice is narrower than the narrative', () => {
	it('stays quiet on a hold with no named cause', () => {
		expect(paceDecisionAdminNotice(CELL, decision({ reason: 'holding' }))).toBeUndefined();
		expect(paceDecisionAdminNotice(CELL, decision({ reason: 'low_utilisation' }))).toBeUndefined();
		expect(
			paceDecisionAdminNotice(CELL, decision({ reason: 'share_moved_first' }))
		).toBeUndefined();
	});

	it('stays quiet on a named cause that changed nothing', () => {
		// A hard stop that is merely STILL TRUE an hour later re-announcing itself
		// every hour is how operators learn to ignore the channel.
		expect(
			paceDecisionAdminNotice(
				CELL,
				decision({ reason: 'dnsbl', fromMultiplier: 0.25, multiplier: 0.25 })
			)
		).toBeUndefined();
	});

	it('speaks on a named cause that moved the dial', () => {
		const notice = paceDecisionAdminNotice(
			CELL,
			decision({
				reason: 'complaint',
				direction: 'decrease',
				fromMultiplier: 1,
				multiplier: 0.5,
				failedGate: 'complaint',
			})
		);
		expect(notice).toBeDefined();
		expect(notice).toContain('complaint');
	});

	it('speaks on a floored dial whose breach advanced the cooldown ladder', () => {
		const notice = paceDecisionAdminNotice(
			CELL,
			decision({
				reason: 'complaint',
				direction: 'hold',
				fromMultiplier: 0.25,
				multiplier: 0.25,
				failedGate: 'complaint',
				freeze: { until: 1, origin: 'gate_breach', ladderMs: 6 * 60 * 60 * 1000 },
			})
		);
		expect(notice).toBeDefined();
	});
});
