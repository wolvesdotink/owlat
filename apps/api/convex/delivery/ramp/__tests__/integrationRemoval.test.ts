/**
 * THE ACCEPTANCE TEST (plan D2, D3, D14).
 *
 * Removing a previously-connected integration must:
 *   1. make the affected gate fall back to its SUBSTITUTE within ONE window,
 *   2. drop the cell's confidence, NAMING the integration that would restore it,
 *   3. and CONTINUE THE RAMP AT REDUCED SPEED rather than halting.
 *
 * "Within one window" is a property of the resolution, not of a scheduler: the
 * presence map is read on every tick and the constants are folded from it, so
 * the tick after the feed stops is already the degraded tick. The test asserts
 * exactly that — resolve twice, once with the integration and once without, and
 * compare — because a substitution that needed a migration, a flag or an
 * operator action would be a substitution that could be forgotten.
 */

import { describe, expect, it } from 'vitest';
import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import {
	degradedCeilingCap,
	degradedStreamConfig,
	resolveRampDegradation,
	usesTrailingBaseline,
} from '../degradation';
import {
	RAMP_FULLY_EQUIPPED,
	type RampIntegrationId,
	type RampIntegrationPresence,
} from '../degradationMatrix';
import { rampCellConfidence } from '../measurementConfidence';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';

function without(id: RampIntegrationId): RampIntegrationPresence {
	const presence: Record<RampIntegrationId, boolean> = { ...RAMP_FULLY_EQUIPPED };
	presence[id] = false;
	return presence;
}

describe('removing a connected integration degrades within one window', () => {
	it('falls back to the substitute gate the moment the reference transport goes', () => {
		const before = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		const after = resolveRampDegradation({
			presence: without('reference_transport'),
			provider: 'gmail',
		});
		expect(usesTrailingBaseline(before)).toBe(false);
		expect(usesTrailingBaseline(after)).toBe(true);
		expect(after.actuator).toBe('pace');
		expect(after.substitutes).toContain('seed_placement');
	});

	it('falls back to SMTP classification the moment SNDS goes', () => {
		const after = resolveRampDegradation({
			presence: without('microsoft_snds'),
			provider: 'microsoft',
		});
		expect(after.substitutes).toEqual(['smtp_classification']);
		expect(degradedCeilingCap(after)).toBeLessThan(OWN_SHARE_CEILING);
	});

	it('falls back to the unsubscribe proxy the moment the feedback loop goes', () => {
		const after = resolveRampDegradation({
			presence: without('complaint_feedback_loop'),
			provider: 'other',
		});
		expect(after.substitutes).toContain('unsubscribe_rate_proxy');
		const config = degradedStreamConfig(RAMP_STREAM_CONFIGS.campaign, after);
		expect(config.thresholds.complaintMax as number).toBeLessThan(
			RAMP_STREAM_CONFIGS.campaign.thresholds.complaintMax as number
		);
	});
});

describe('the confidence drop names the integration that would restore it', () => {
	it('names Google Postmaster on the gmail cell', () => {
		const degradation = resolveRampDegradation({
			presence: without('google_postmaster'),
			provider: 'gmail',
		});
		const confidence = rampCellConfidence({ degradation, evaluated: 'high' });
		expect(confidence.level).not.toBe('high');
		expect(confidence.improvements.map((offer) => offer.integration)).toEqual([
			'google_postmaster',
		]);
		expect(confidence.improvements[0]?.improvement).toMatch(/Google Postmaster/);
	});

	it('names seed mailboxes — the one absence with no substitute at all', () => {
		const degradation = resolveRampDegradation({
			presence: without('seed_mailboxes'),
			provider: 'gmail',
		});
		expect(degradation.substitutes).toHaveLength(0);
		const confidence = rampCellConfidence({ degradation, evaluated: 'high' });
		expect(confidence.level).toBe('low');
		expect(confidence.improvements.map((offer) => offer.integration)).toEqual(['seed_mailboxes']);
		// The reason is stated on the cell, not hidden behind a support article.
		expect(degradation.absent[0]?.paceCeilingDay).toBe(14);
	});
});

describe('the ramp continues at reduced speed rather than halting', () => {
	const degradation = resolveRampDegradation({
		presence: without('reference_transport'),
		provider: 'gmail',
	});
	const base = RAMP_STREAM_CONFIGS.campaign;
	const degraded = degradedStreamConfig(base, degradation);

	it('still advances — the step is smaller, never zero', () => {
		expect(degraded.increaseStep as number).toBeGreaterThan(0);
		expect(degraded.increaseStep as number).toBeLessThan(base.increaseStep as number);
	});

	it('still advances — the confidence requirement is longer, never infinite', () => {
		expect(degraded.cleanWindowsRequired).toBeGreaterThan(base.cleanWindowsRequired);
		expect(Number.isFinite(degraded.cleanWindowsRequired)).toBe(true);
	});

	it('still reaches the top rung — a cap is not a halt', () => {
		expect(degradedCeilingCap(degradation)).toBe(OWN_SHARE_CEILING);
	});

	it('blocks nothing, anywhere in the resolution', () => {
		expect(degradation.isBlocking).toBe(false);
		for (const entry of degradation.absent) expect(entry.isBlocking).toBe(false);
	});

	it('reconnecting restores the equipped constants with no migration', () => {
		const restored = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		expect(degradedStreamConfig(base, restored)).toBe(base);
		expect(usesTrailingBaseline(restored)).toBe(false);
	});
});
