/**
 * THE SUBSTITUTION TABLE, ASSERTED AS A TABLE (plan D3).
 *
 * One case per absent integration, each naming the substituted gate, the
 * tightened constants and the capped ceiling the plan specifies. Table-driven on
 * purpose: a new integration is a row here and a row in the matrix, and a row
 * with no expectation fails `noScatteredConditionals.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	degradedCeilingCap,
	degradedStreamConfig,
	resolveRampDegradation,
	usesTrailingBaseline,
	type RampActuator,
} from '../degradation';
import {
	RAMP_DEGRADATION_BY_INTEGRATION,
	RAMP_FULLY_EQUIPPED,
	RAMP_INTEGRATION_IDS,
	type RampIntegrationId,
	type RampIntegrationPresence,
	type RampSubstituteSource,
} from '../degradationMatrix';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

function absent(...ids: readonly RampIntegrationId[]): RampIntegrationPresence {
	const presence: Record<RampIntegrationId, boolean> = { ...RAMP_FULLY_EQUIPPED };
	for (const id of ids) presence[id] = false;
	return presence;
}

interface MatrixCase {
	readonly integration: RampIntegrationId;
	readonly provider: DestinationProviderKey;
	/** A provider the entry must NOT govern, when it is provider-scoped. */
	readonly outOfScopeProvider?: DestinationProviderKey;
	readonly substitutes: readonly RampSubstituteSource[];
	readonly cleanWindowsRequired: number | undefined;
	readonly stepMultiplier: number;
	readonly dwellMultiplier: number;
	readonly ceilingCap: number;
	readonly complaintMax: number | undefined;
	/**
	 * The complaint gate's RELATIVE half, in PERCENTAGE POINTS while `complaintMax`
	 * is a FRACTION. Asserted beside it precisely because the pair carries two
	 * units: a proxy line half as wide judged against the equipped tolerance would
	 * let the relative half pass what the absolute half just failed, and a
	 * pp/fraction slip in either override is invisible from the other.
	 */
	readonly complaintTolerance: number | undefined;
	readonly paceCeilingDay: number | undefined;
	readonly actuator: RampActuator;
}

const CASES: readonly MatrixCase[] = [
	{
		// REFERENCE TRANSPORT absent -> substitute the pace actuator, trailing-baseline
		// engagement and seed placement; K_CLEAN 3 -> 5 and step HALVED.
		integration: 'reference_transport',
		provider: 'gmail',
		substitutes: ['pace_actuator', 'trailing_baseline_engagement', 'seed_placement'],
		cleanWindowsRequired: 5,
		stepMultiplier: 0.5,
		dwellMultiplier: 1,
		ceilingCap: 1,
		complaintMax: undefined,
		complaintTolerance: undefined,
		paceCeilingDay: undefined,
		actuator: 'pace',
	},
	{
		// GOOGLE POSTMASTER absent -> our own bounce/deferral/complaint rates for the
		// google cell plus seeds at Gmail; DWELL TIME x2.
		integration: 'google_postmaster',
		provider: 'gmail',
		outOfScopeProvider: 'yahoo',
		substitutes: ['own_bounce_deferral_complaint', 'seed_placement'],
		cleanWindowsRequired: undefined,
		stepMultiplier: 1,
		dwellMultiplier: 2,
		ceilingCap: 1,
		complaintMax: undefined,
		complaintTolerance: undefined,
		paceCeilingDay: undefined,
		actuator: 'share',
	},
	{
		// MICROSOFT SNDS absent -> SMTP reply classification; DWELL x2 AND the
		// microsoft cell ceiling capped ONE PHASE LOWER.
		integration: 'microsoft_snds',
		provider: 'microsoft',
		outOfScopeProvider: 'gmail',
		substitutes: ['smtp_classification'],
		cleanWindowsRequired: undefined,
		stepMultiplier: 1,
		dwellMultiplier: 2,
		ceilingCap: 0.8,
		complaintMax: undefined,
		complaintTolerance: undefined,
		paceCeilingDay: undefined,
		actuator: 'share',
	},
	{
		// ANY FBL absent -> CFBL-Address reports and the unsubscribe-rate proxy;
		// complaint threshold tightened 0.1% -> 0.05% equivalent.
		integration: 'complaint_feedback_loop',
		provider: 'other',
		substitutes: ['cfbl_address_reports', 'unsubscribe_rate_proxy'],
		cleanWindowsRequired: undefined,
		stepMultiplier: 1,
		dwellMultiplier: 1,
		ceilingCap: 1,
		complaintMax: 0.0005,
		complaintTolerance: 0.025,
		paceCeilingDay: undefined,
		actuator: 'share',
	},
	{
		// SEED MAILBOXES absent -> substitute NOTHING; pace may not exceed the base
		// schedule's DAY-14 cap.
		integration: 'seed_mailboxes',
		provider: 'apple',
		substitutes: [],
		cleanWindowsRequired: undefined,
		stepMultiplier: 1,
		dwellMultiplier: 1,
		ceilingCap: 1,
		complaintMax: undefined,
		complaintTolerance: undefined,
		paceCeilingDay: 14,
		actuator: 'share',
	},
	{
		// COMMERCIAL PLACEMENT API absent -> self-hosted seeds; NO CHANGE.
		integration: 'commercial_placement_api',
		provider: 'gmail',
		substitutes: ['self_hosted_seeds'],
		cleanWindowsRequired: undefined,
		stepMultiplier: 1,
		dwellMultiplier: 1,
		ceilingCap: 1,
		complaintMax: undefined,
		complaintTolerance: undefined,
		paceCeilingDay: undefined,
		actuator: 'share',
	},
];

describe('the degradation matrix substitutes exactly what the plan says', () => {
	it('covers every integration exactly once', () => {
		expect(CASES.map((c) => c.integration).sort()).toEqual([...RAMP_INTEGRATION_IDS].sort());
		expect(RAMP_DEGRADATION_BY_INTEGRATION.size).toBe(RAMP_INTEGRATION_IDS.length);
	});

	for (const testCase of CASES) {
		describe(`${testCase.integration} absent`, () => {
			const degradation = resolveRampDegradation({
				presence: absent(testCase.integration),
				provider: testCase.provider,
			});

			it('substitutes the documented sources', () => {
				expect(degradation.substitutes).toEqual(testCase.substitutes);
			});

			it('tightens the documented constants', () => {
				expect(degradation.cleanWindowsRequired).toBe(testCase.cleanWindowsRequired);
				expect(degradation.stepMultiplier).toBe(testCase.stepMultiplier);
				expect(degradation.dwellMultiplier).toBe(testCase.dwellMultiplier);
				expect(degradation.paceCeilingDay).toBe(testCase.paceCeilingDay);
			});

			it('caps the ceiling where the plan caps it', () => {
				expect(degradedCeilingCap(degradation)).toBe(testCase.ceilingCap);
			});

			it('applies the documented complaint threshold AND its tolerance', () => {
				const config = degradedStreamConfig(RAMP_STREAM_CONFIGS.campaign, degradation);
				const expectedMax =
					testCase.complaintMax ?? RAMP_STREAM_CONFIGS.campaign.thresholds.complaintMax;
				expect(config.thresholds.complaintMax as number).toBeCloseTo(expectedMax, 10);
				const expectedTolerance =
					testCase.complaintTolerance ?? RAMP_STREAM_CONFIGS.campaign.thresholds.complaintTolerance;
				expect(config.thresholds.complaintTolerance as number).toBeCloseTo(expectedTolerance, 10);
			});

			it('drives the documented actuator', () => {
				expect(degradation.actuator).toBe(testCase.actuator);
			});

			it('never blocks anything (plan D2)', () => {
				expect(degradation.isBlocking).toBe(false);
				for (const entry of degradation.absent) expect(entry.isBlocking).toBe(false);
			});

			const outOfScope = testCase.outOfScopeProvider;
			if (outOfScope !== undefined) {
				it('governs only the cells the plan scopes it to', () => {
					const elsewhere = resolveRampDegradation({
						presence: absent(testCase.integration),
						provider: outOfScope,
					});
					expect(elsewhere.absent).toHaveLength(0);
					expect(elsewhere.substitutes).toHaveLength(0);
				});
			}
		});
	}
});

describe('the fully-equipped deployment is the identity', () => {
	it('changes no constant and no config object', () => {
		const degradation = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		expect(degradation.absent).toHaveLength(0);
		expect(degradation.stepMultiplier).toBe(1);
		expect(degradation.dwellMultiplier).toBe(1);
		expect(degradation.ceilingPhaseDelta).toBe(0);
		expect(degradation.confidence).toBe('high');
		expect(usesTrailingBaseline(degradation)).toBe(false);
		expect(degradedStreamConfig(RAMP_STREAM_CONFIGS.campaign, degradation)).toBe(
			RAMP_STREAM_CONFIGS.campaign
		);
	});
});

describe('several absences compose rather than override', () => {
	const degradation = resolveRampDegradation({
		presence: absent('reference_transport', 'microsoft_snds', 'complaint_feedback_loop'),
		provider: 'microsoft',
	});

	it('takes the strictest K_CLEAN, multiplies the multipliers and sums the ceiling delta', () => {
		expect(degradation.cleanWindowsRequired).toBe(5);
		expect(degradation.stepMultiplier).toBe(0.5);
		expect(degradation.dwellMultiplier).toBe(2);
		expect(degradedCeilingCap(degradation)).toBe(0.8);
	});

	it('halves the step of the stream it is applied to', () => {
		const config = degradedStreamConfig(RAMP_STREAM_CONFIGS.campaign, degradation);
		expect(config.increaseStep as number).toBeCloseTo(2.5, 10);
		expect(config.cleanWindowsRequired).toBe(5);
		// The transactional stream's +3pp halves to +1.5pp by the same rule.
		const transactional = degradedStreamConfig(RAMP_STREAM_CONFIGS.transactional, degradation);
		expect(transactional.increaseStep as number).toBeCloseTo(1.5, 10);
	});

	it('reports the weakest confidence of the absent entries', () => {
		expect(degradation.confidence).toBe('low');
	});
});
