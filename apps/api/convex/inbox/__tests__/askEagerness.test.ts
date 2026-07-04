/**
 * Tests for the pure ask-eagerness policy + instrumentation helpers
 * (inbox/askEagerness.ts). No Convex, no model — deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
	asEagernessMode,
	resolveEagernessPolicy,
	isHighStakesSlot,
	predictedAskValue,
	measureDraftDelta,
	shouldSampleDraftDelta,
	DRAFT_DELTA_SAMPLE_RATE,
	EAGERNESS_MODES,
} from '../askEagerness';
import { MAX_QUESTIONS } from '../clarificationSlots';

describe('asEagernessMode', () => {
	it('accepts the four modes and rejects everything else', () => {
		for (const mode of EAGERNESS_MODES) {
			expect(asEagernessMode(mode)).toBe(mode);
		}
		expect(asEagernessMode('nonsense')).toBeUndefined();
		expect(asEagernessMode(null)).toBeUndefined();
		expect(asEagernessMode(undefined)).toBeUndefined();
	});
});

describe('resolveEagernessPolicy', () => {
	const routine = { categoryCautious: false };
	const highStakesCategory = { categoryCautious: true };

	it("no setting reproduces today's behaviour (full cap, no filter, category-driven check)", () => {
		expect(resolveEagernessPolicy(undefined, routine)).toEqual({
			enabled: true,
			maxQuestions: MAX_QUESTIONS,
			highStakesOnly: false,
			forceCheck: false,
		});
		// complaint/urgent still force the check even with no dial set.
		expect(resolveEagernessPolicy(undefined, highStakesCategory).forceCheck).toBe(true);
	});

	it('Off disables asking', () => {
		expect(resolveEagernessPolicy('off', routine)).toEqual({
			enabled: false,
			maxQuestions: 0,
			highStakesOnly: false,
			forceCheck: false,
		});
	});

	it('Confident raises the bar vs Cautious', () => {
		const cautious = resolveEagernessPolicy('cautious', routine);
		const confident = resolveEagernessPolicy('confident', routine);
		expect(confident.maxQuestions).toBeLessThan(cautious.maxQuestions);
		expect(confident.highStakesOnly).toBe(true);
		expect(cautious.highStakesOnly).toBe(false);
		// Cautious always runs the check; Confident defers to category on routine mail.
		expect(cautious.forceCheck).toBe(true);
		expect(confident.forceCheck).toBe(false);
	});

	it('Balanced sits between the two', () => {
		const balanced = resolveEagernessPolicy('balanced', routine);
		expect(balanced.maxQuestions).toBe(2);
		expect(balanced.highStakesOnly).toBe(false);
	});

	it('never exceeds the hard MAX_QUESTIONS ceiling', () => {
		for (const mode of EAGERNESS_MODES) {
			expect(resolveEagernessPolicy(mode, routine).maxQuestions).toBeLessThanOrEqual(MAX_QUESTIONS);
		}
	});
});

describe('isHighStakesSlot', () => {
	it('flags money / commitment / date / tone; not routine lookups', () => {
		expect(isHighStakesSlot('price_number')).toBe(true);
		expect(isHighStakesSlot('decision')).toBe(true);
		expect(isHighStakesSlot('date_time')).toBe(true);
		expect(isHighStakesSlot('stance_tone')).toBe(true);
		expect(isHighStakesSlot('factual_lookup')).toBe(false);
		expect(isHighStakesSlot('attachment')).toBe(false);
	});
});

describe('predictedAskValue', () => {
	it('scores an all-high-stakes ask higher than a routine one', () => {
		expect(predictedAskValue([])).toBe(0);
		expect(predictedAskValue(['decision', 'price_number'])).toBeCloseTo(1);
		const routine = predictedAskValue(['factual_lookup']);
		const stakes = predictedAskValue(['decision']);
		expect(stakes).toBeGreaterThan(routine);
		// Any ask has a non-zero floor.
		expect(routine).toBeGreaterThan(0);
		expect(routine).toBeLessThan(1);
	});
});

describe('measureDraftDelta', () => {
	it('flags a materially different draft as changed', () => {
		const delta = measureDraftDelta(
			'Yes, we can ship the order on March 3rd for $400.',
			'Thanks for reaching out, I will get back to you shortly.'
		);
		expect(delta.changed).toBe(true);
		expect(delta.divergence).toBeGreaterThan(0);
	});

	it('flags an identical draft as unchanged', () => {
		const text = 'Thanks, that works for me.';
		const delta = measureDraftDelta(text, text);
		expect(delta.changed).toBe(false);
		expect(delta.similarity).toBe(1);
		expect(delta.divergence).toBe(0);
	});
});

describe('shouldSampleDraftDelta', () => {
	it('samples below the rate and skips at/above it', () => {
		expect(shouldSampleDraftDelta(0)).toBe(true);
		expect(shouldSampleDraftDelta(DRAFT_DELTA_SAMPLE_RATE - 0.0001)).toBe(true);
		expect(shouldSampleDraftDelta(DRAFT_DELTA_SAMPLE_RATE)).toBe(false);
		expect(shouldSampleDraftDelta(0.99)).toBe(false);
	});
});
