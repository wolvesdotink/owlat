/**
 * Gate 4 — MPP / PIXEL SUPPRESSION.
 *
 * Apple Mail Privacy Protection pre-fetches the tracking pixel for every
 * message, so an Apple cell's open rate measures Apple's proxy rather than our
 * deliverability. The Apple cell is gated on CLICKS; every other cell on opens.
 *
 * The substitution must be CONFIGURATION, not an `if (provider === 'apple')`
 * buried in the arithmetic — so the suite exercises it through the table AND
 * through per-evaluation overrides, and the two must agree.
 */

import { describe, expect, it } from 'vitest';
import {
	DESTINATION_PROVIDER_KEYS,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import {
	ENGAGEMENT_METRIC_BY_PROVIDER,
	resolveEngagementMetric,
	type EngagementMetricOverrides,
} from '../engagementConfig';
import { evaluateEngagementRatioGate } from '../engagementGate';
import { engagementArm, engagementInput } from './gateFixtures';

/**
 * The own arm's OPENS collapse while its CLICKS hold. On an opens-gated cell
 * that is a fail; on the Apple cell — where the opens are MPP noise — it is a
 * pass. One fixture, two answers, and the ONLY difference is the cell.
 */
const OWN = engagementArm({
	sent: 20_000,
	calibrationSent: 2_000,
	calibrationOpened: 100, // 5%
	calibrationClicked: 200, // 10%
});

const REFERENCE = engagementArm({
	sent: 20_000,
	calibrationSent: 2_000,
	calibrationOpened: 800, // 40%
	calibrationClicked: 200, // 10%
});

function verdictFor(
	destinationProvider: DestinationProviderKey,
	metricOverrides?: EngagementMetricOverrides
) {
	return evaluateEngagementRatioGate(
		engagementInput({
			own: OWN,
			reference: REFERENCE,
			destinationProvider,
			...(metricOverrides === undefined ? {} : { metricOverrides }),
		})
	);
}

describe('gate 4 — MPP metric substitution', () => {
	it('gates the apple cell on CLICK rate', () => {
		expect(ENGAGEMENT_METRIC_BY_PROVIDER.apple).toBe('click');
		const result = verdictFor('apple');
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBeCloseTo(0.1, 10);
		expect(result.measurement.referenceRate).toBeCloseTo(0.1, 10);
	});

	it('gates every other cell on OPEN rate', () => {
		for (const provider of DESTINATION_PROVIDER_KEYS) {
			if (provider === 'apple') continue;
			expect(ENGAGEMENT_METRIC_BY_PROVIDER[provider]).toBe('open');
			const result = verdictFor(provider);
			expect(result.status).toBe('fail');
			expect(result.measurement.ownRate).toBeCloseTo(0.05, 10);
		}
	});

	it('the substitution is configuration-driven — an override flips apple to opens', () => {
		const result = verdictFor('apple', { apple: 'open' });
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBeCloseTo(0.05, 10);
	});

	it('the substitution is configuration-driven — an override flips gmail to clicks', () => {
		const result = verdictFor('gmail', { gmail: 'click' });
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBeCloseTo(0.1, 10);
	});

	it('an override for another provider leaves this cell on the table default', () => {
		expect(verdictFor('gmail', { apple: 'open' }).status).toBe('fail');
	});

	it('resolveEngagementMetric covers every destination provider key', () => {
		for (const provider of DESTINATION_PROVIDER_KEYS) {
			expect(['open', 'click']).toContain(resolveEngagementMetric(provider));
		}
	});

	it('the ratio is computed per cell, so constant per-provider inflation cancels', () => {
		// Both arms inflated 4x by the same proxy: the RATIO is unchanged.
		const inflated = evaluateEngagementRatioGate(
			engagementInput({
				own: engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 400 }),
				reference: engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 400 }),
				destinationProvider: 'gmail',
			})
		);
		const plain = evaluateEngagementRatioGate(
			engagementInput({
				own: engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 100 }),
				reference: engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 100 }),
				destinationProvider: 'gmail',
			})
		);
		expect(inflated.status).toBe('pass');
		expect(plain.status).toBe('pass');
	});
});
