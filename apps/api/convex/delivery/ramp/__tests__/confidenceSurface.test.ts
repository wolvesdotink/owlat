/**
 * EVERY CELL SAYS WHAT ITS MEASUREMENT IS WORTH (plan D14) — and offers a fix.
 *
 * The second half is the part that is easy to skip and the part D2 is about: a
 * confidence level with no affordance is a nag, and a confidence level rendered
 * as a warning is an unresolvable error state on a SUPPORTED configuration. So
 * this suite asserts the tone as hard as it asserts the level.
 */

import { describe, expect, it } from 'vitest';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { resolveRampDegradation } from '../degradation';
import {
	RAMP_DEGRADATION_MATRIX,
	RAMP_FULLY_EQUIPPED,
	RAMP_FULLY_STANDALONE,
} from '../degradationMatrix';
import { rampCellConfidence, RAMP_CONFIDENCE_TONE } from '../measurementConfidence';

/** Words that would turn an offer into a nag or an error state. */
const NAG_WORDS = /incomplete|required|must connect|error|invalid|failed|action needed|warning/i;

describe('every cell exposes a confidence level', () => {
	for (const provider of DESTINATION_PROVIDER_KEYS) {
		it(`${provider} — standalone`, () => {
			const confidence = rampCellConfidence({
				degradation: resolveRampDegradation({ presence: RAMP_FULLY_STANDALONE, provider }),
				evaluated: 'high',
			});
			expect(['high', 'medium', 'low']).toContain(confidence.level);
			expect(confidence.headline).toMatch(/^Measurement confidence: /);
			expect(confidence.provider).toBe(provider);
		});

		it(`${provider} — fully equipped`, () => {
			const confidence = rampCellConfidence({
				degradation: resolveRampDegradation({ presence: RAMP_FULLY_EQUIPPED, provider }),
				evaluated: 'high',
			});
			expect(confidence.level).toBe('high');
			expect(confidence.improvements).toHaveLength(0);
			expect(confidence.notes).toHaveLength(0);
		});
	}
});

describe('the affordance is concrete — it names the integration and what it buys', () => {
	for (const entry of RAMP_DEGRADATION_MATRIX) {
		it(`${entry.integration} offers a specific improvement`, () => {
			expect(entry.improvement.length).toBeGreaterThan(20);
			expect(entry.confidenceNote).toMatch(/confidence/i);
			// The offer names a thing to connect or add, not a state to fix.
			expect(entry.improvement).toMatch(/connect|add|enrol|enroll|service/i);
		});
	}

	it('carries one offer per absent integration governing the cell', () => {
		const degradation = resolveRampDegradation({
			presence: RAMP_FULLY_STANDALONE,
			provider: 'microsoft',
		});
		const confidence = rampCellConfidence({ degradation, evaluated: 'high' });
		expect(confidence.improvements.map((offer) => offer.integration)).toEqual(
			degradation.absent.map((entry) => entry.integration)
		);
		expect(confidence.notes).toEqual(degradation.absent.map((entry) => entry.confidenceNote));
	});
});

describe('none of it renders as a warning or a nag (plan D2)', () => {
	it('the tone is informational and cannot be anything else', () => {
		const confidence = rampCellConfidence({
			degradation: resolveRampDegradation({
				presence: RAMP_FULLY_STANDALONE,
				provider: 'gmail',
			}),
			evaluated: 'low',
		});
		expect(confidence.tone).toBe(RAMP_CONFIDENCE_TONE);
		expect(confidence.tone).toBe('info');
		expect(confidence.isBlocking).toBe(false);
	});

	it('no copy in the table reads as an error or an unfinished setup', () => {
		for (const entry of RAMP_DEGRADATION_MATRIX) {
			expect(entry.confidenceNote).not.toMatch(NAG_WORDS);
			expect(entry.improvement).not.toMatch(NAG_WORDS);
			expect(entry.isBlocking).toBe(false);
		}
	});
});

describe('the level is the weakest of what was measured and what could be', () => {
	it('a low-confidence evaluation drags a fully-equipped cell down', () => {
		const confidence = rampCellConfidence({
			degradation: resolveRampDegradation({ presence: RAMP_FULLY_EQUIPPED, provider: 'gmail' }),
			evaluated: 'low',
		});
		expect(confidence.level).toBe('low');
	});

	it('an absent integration drags a high-confidence evaluation down', () => {
		const confidence = rampCellConfidence({
			degradation: resolveRampDegradation({
				presence: { ...RAMP_FULLY_EQUIPPED, reference_transport: false },
				provider: 'gmail',
			}),
			evaluated: 'high',
		});
		expect(confidence.level).toBe('low');
	});
});
