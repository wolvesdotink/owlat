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
	RAMP_SUBSTITUTE_SOURCES,
	type RampIntegrationId,
	type RampSubstituteSource,
} from '../degradationMatrix';
import { SNDS_ABSENT_SUBSTITUTION } from '../sndsGate';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import { absent } from './controllerFixtures';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

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
		// MICROSOFT SNDS absent -> our own bounce/deferral/complaint rates for the
		// microsoft cell plus seeds at Outlook; DWELL x2 AND the microsoft cell
		// ceiling capped ONE PHASE LOWER.
		//
		// NOT `smtp_classification` (issue #501): the classifier runs in the MTA and
		// nothing carries its per-category counts into Convex, so a cell claiming to
		// run on it was claiming a signal no deployment supplies.
		integration: 'microsoft_snds',
		provider: 'microsoft',
		outOfScopeProvider: 'gmail',
		substitutes: ['own_bounce_deferral_complaint', 'seed_placement'],
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

/**
 * EVERY NAMED SIGNAL IS A SIGNAL SOMETHING RUNS ON (issue #501).
 *
 * The table is what the dashboard renders and what the audit row records, so a
 * source in the vocabulary that no entry claims is a name waiting to be pasted
 * onto a cell — and a source an entry claims that nothing supplies is worse: it
 * tells an operator their cell is measured by something that never executes.
 * `smtp_classification` was exactly that for the Microsoft cell. It comes back
 * when the MTA -> Convex transport telemetry does, and this suite is what makes
 * "when" a build failure rather than a memory.
 */
describe('the substitution table names only signals that run', () => {
	it('leaves no source in the vocabulary unclaimed by an entry', () => {
		const claimed = new Set<RampSubstituteSource>();
		for (const entry of RAMP_DEGRADATION_BY_INTEGRATION.values()) {
			for (const source of entry.substitutes) claimed.add(source);
		}
		expect([...RAMP_SUBSTITUTE_SOURCES].filter((source) => !claimed.has(source))).toEqual([]);
	});

	it('does not offer the operator a signal the ramp cannot read', () => {
		// The gate clause is still implemented and still pinned
		// (`smtpBlockMessage.test.ts`); what is gone is the CLAIM that a deployment
		// is running on it. Spelled as a string search over the whole table so a
		// future entry cannot reintroduce the promise in prose either.
		const table = [...RAMP_DEGRADATION_BY_INTEGRATION.values()];
		expect(table.flatMap((entry) => entry.substitutes)).not.toContain('smtp_classification');
		for (const entry of table) {
			expect(entry.confidenceNote).not.toMatch(/SMTP reply|SMTP classification/i);
		}
	});

	it('leaves the Microsoft cell reading what it actually reads', () => {
		const degradation = resolveRampDegradation({
			presence: absent('microsoft_snds'),
			provider: 'microsoft',
		});
		expect(degradation.substitutes).toEqual(['own_bounce_deferral_complaint', 'seed_placement']);
		// The cost of the absence is UNCHANGED — this piece corrected a claim, not a
		// constant, and a quieter ramp would be a different change hiding in a doc fix.
		expect(degradation.dwellMultiplier).toBe(2);
		expect(degradedCeilingCap(degradation)).toBe(0.8);
	});

	it('says the same thing on the SNDS gate as in the table — in the same words', () => {
		// Two entries describing one cell: the P3-8 table and the gate input's own
		// substitution shape. They are read by different screens, so the guard has
		// to compare the COPY. Comparing only the source name passes by construction
		// — the gate's single name is trivially one of the table's list — while the
		// rendered sentences drift, which is exactly what had happened: the table
		// named seed placement beside the cell's own rates and the gate's note
		// stopped at the rates.
		const entry = RAMP_DEGRADATION_BY_INTEGRATION.get('microsoft_snds');
		expect(entry?.substitutes).toContain(SNDS_ABSENT_SUBSTITUTION.source);
		expect(SNDS_ABSENT_SUBSTITUTION.confidenceNote.startsWith(entry?.confidenceNote ?? '#')).toBe(
			true
		);
		// The one clause the gate row adds, because the table keeps it in a separate
		// `improvement` field the gate row has nowhere to render.
		expect(SNDS_ABSENT_SUBSTITUTION.confidenceNote.slice(entry?.confidenceNote.length ?? 0)).toBe(
			' Connecting SNDS would measure this IP’s complaint band directly.'
		);
		expect(SNDS_ABSENT_SUBSTITUTION.confidenceNote).not.toMatch(/SMTP reply/i);
	});
});

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

			it('caps the ceiling where the plan caps it, and NAMES what capped it', () => {
				expect(degradedCeilingCap(degradation)).toBe(testCase.ceilingCap);
				// The cap and its cause come from ONE fold: an audit row that states a
				// cap must be able to say which absence produced it (plan D12).
				const caps = degradation.ceilingPhaseDelta !== 0;
				expect(degradation.ceilingCappedBy).toBe(caps ? testCase.integration : undefined);
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
		expect(degradation.ceilingCappedBy).toBeUndefined();
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
