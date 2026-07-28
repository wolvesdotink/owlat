/**
 * THE SENTENCE UNDER A GATE'S VERDICT — units, and the two places they change.
 *
 * `gateExplanation` renders the numbers an operator acts on, and under plan D12
 * the same fields feed the audit row and the admin notification. Almost every
 * verdict is denominated in SENDS, and the generic sentence says so in words —
 * so the exceptions have to be branched on rather than assumed away. There is
 * exactly one today: the block-message hard stop counts CLASSIFIED SMTP
 * RESPONSES, and printing "24 sends" under a verdict that stopped a cell is a
 * number the operator would act on and be wrong about.
 *
 * The hold vocabulary is covered here too, because the switch is exhaustive on
 * purpose: a new `RampGateHoldReason` must arrive with its own sentence, and a
 * sentence that reads like a fault under a reason that is not one is the D2
 * failure mode ("nothing merely UNMEASURED is rendered as a problem").
 */

import { describe, expect, it } from 'vitest';
import {
	blockMessageHalt,
	failingGate,
	holdingGate,
	passingGate,
} from '~/components/delivery/__tests__/measurementFixtures';
import {
	gateExplanation,
	type DeliverabilityDashboardGate,
} from '~/utils/deliverabilityMeasurement';

describe('gateExplanation — units', () => {
	it('denominates an ordinary verdict in sends', () => {
		expect(gateExplanation(passingGate())).toContain('over 1,000 sends');
		expect(gateExplanation(failingGate())).toContain('over 1,200 sends');
	});

	it('never calls a classified SMTP response a send', () => {
		const sentence = gateExplanation(blockMessageHalt());
		expect(sentence).toContain('240 classified SMTP responses');
		expect(sentence).toContain('block messages');
		// THE DEFECT THIS PINS: the generic branch would have printed "over 240
		// sends", and 240 is a response count.
		expect(sentence).not.toContain('sends');
	});

	it('still reports the limit the halt compared against', () => {
		expect(gateExplanation(blockMessageHalt())).toContain('0.50%');
	});

	it('prints the own sample against its floor in the SAME unit on a hold', () => {
		expect(gateExplanation(holdingGate())).toContain('124 of 400 sends');
	});
});

describe('gateExplanation — a hold is never rendered as a fault', () => {
	type HoldingGate = Extract<DeliverabilityDashboardGate, { status: 'insufficient_data' }>;

	/** A hold with a chosen reason. Written out rather than spread: the union's
	 * `reason` narrows with `status`, and a spread would widen both back. */
	function held(reason: HoldingGate['reason']): DeliverabilityDashboardGate {
		return {
			gate: 'hard_bounce',
			status: 'insufficient_data',
			reason,
			measurement: {
				thresholdRate: 0.02,
				toleranceValuePp: 0.5,
				ownSample: 124,
				referenceSample: null,
				minSample: 400,
				ownRate: null,
				referenceRate: null,
			},
			confidence: 'high',
			mayJustifyIncrease: true,
		};
	}

	const HOLD_REASONS: readonly HoldingGate['reason'][] = [
		'own_sample_below_floor',
		'reference_sample_below_floor',
		'baseline_sample_below_floor',
		'own_evidence_stale',
		'reference_evidence_stale',
		'baseline_evidence_stale',
		'own_rate_unmeasurable',
		'reference_rate_unmeasurable',
		'baseline_rate_unmeasurable',
		'reference_not_a_denominator',
		'baseline_not_a_denominator',
		'evidence_absent',
	];

	for (const reason of HOLD_REASONS) {
		it(`${reason} renders a sentence, never an error`, () => {
			const sentence = gateExplanation(held(reason));
			expect(sentence.length).toBeGreaterThan(0);
			expect(sentence).not.toContain('undefined');
			const lower = sentence.toLowerCase();
			for (const word of ['error', 'failed', 'incomplete', 'required']) {
				expect(lower).not.toContain(word);
			}
		});
	}

	it('says a clean comparison window is clean, not corrupt', () => {
		// `*_not_a_denominator` and `*_rate_unmeasurable` are two different stories
		// and must not share one sentence: one sends the operator to investigate a
		// poisoned bucket, the other says there is simply nothing to divide by.
		const clean = gateExplanation(held('baseline_not_a_denominator'));
		const poisoned = gateExplanation(held('baseline_rate_unmeasurable'));
		expect(clean).not.toBe(poisoned);
		expect(clean).toContain('too clean');
	});
});
