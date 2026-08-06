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
		// NOT `smtp_classification` (issue #501): the counts reach Convex now, but
		// the clause that reads them is on the standalone evaluator alone, and this
		// entry covers relay-equipped deployments whose gate 2 never consults it.
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
 * THE SIGNALS THIS TABLE MAY NOT CLAIM, each with the reason it may not — the
 * shape `gateInputWiring.test.ts` keeps its `KNOWN_UNSUPPLIED` gaps in, applied
 * to the substitution vocabulary. A NAMED LIST rather than one hard-coded string
 * search, so the next unclaimable signal is covered by adding a line here instead
 * of by somebody remembering to write a second assertion.
 *
 * `smtp_classification` — the per-ISP block-message signal. It began here as a
 * signal with NO PRODUCER (issue #501): the classifier ran in the MTA and nothing
 * carried its per-category counts into Convex, so `smtpBlocks` was never set. It
 * has one now, and the reason it still may not be named is a narrower one that
 * the missing producer was hiding: the clause that consumes those counts
 * (`evaluateSmtpBlockMessages`) belongs to the STANDALONE evaluator alone, while
 * every entry in this table applies to relay-equipped deployments too. Naming it
 * would tell a relay-equipped operator their cell is measured by something its
 * evaluator never consults — the same defect as before, for a different reason,
 * on a smaller share of deployments.
 *
 * The gate clause is implemented, reached (`delivery/__tests__/smtpBlockWiring.test.ts`)
 * and pinned (`smtpBlockMessage.test.ts`). What may not come back until the table
 * can express the condition is the CLAIM, in a name or in prose, that every cell
 * this table covers is measured by it.
 *
 * `prose` is the second half of each entry because the table is rendered, not
 * just read: a confidence note can promise the signal to an operator without the
 * source name appearing anywhere.
 */
const SOURCES_THE_TABLE_MAY_NOT_CLAIM: readonly { source: string; prose: RegExp }[] = [
	{
		source: 'smtp_classification',
		prose: /SMTP reply|SMTP classification|block message/i,
	},
];

/**
 * EVERY NAMED SIGNAL IS A SIGNAL EVERY CELL IT IS NAMED FOR RUNS ON (issue #501).
 *
 * The table is what the CONTROLLER runs on — `resolveRampDegradation` folds
 * `substitutes` into which actuator a cell drives, which evaluator judges it and
 * which complaint line applies, and the audit row records the absent
 * INTEGRATIONS behind those constants. So a source in the vocabulary that no
 * entry claims is a name waiting to be pasted onto a cell — and a source an
 * entry claims that a cell it covers never consults is worse: it tells the
 * controller (and, the day a screen renders the copy, an operator) that a cell
 * is measured by something that never executes for it. `smtp_classification`
 * was exactly that for the Microsoft cell, first because it had no producer at
 * all and now because its one consumer is the standalone evaluator while the
 * `microsoft_snds` row covers relay-equipped cells too. It comes back when the
 * table can express that condition, and this suite is what makes "when" a
 * build failure rather than a memory.
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
		// The tracked list against what the table actually offers — the vocabulary,
		// the entries and the rendered copy, because a cell can be promised a signal
		// by a name in `substitutes` OR by a sentence that never names it.
		const table = [...RAMP_DEGRADATION_BY_INTEGRATION.values()];
		const vocabulary: readonly string[] = RAMP_SUBSTITUTE_SOURCES;
		const offered: readonly string[] = table.flatMap((entry) => entry.substitutes);
		// The control. An empty `offered` would pass every exclusion below without
		// reading a single entry, which is the way this guard would rot.
		expect(offered.length).toBeGreaterThan(0);
		expect(SOURCES_THE_TABLE_MAY_NOT_CLAIM.length).toBeGreaterThan(0);
		for (const { source, prose } of SOURCES_THE_TABLE_MAY_NOT_CLAIM) {
			expect(vocabulary).not.toContain(source);
			expect(offered).not.toContain(source);
			for (const entry of table) expect(entry.confidenceNote).not.toMatch(prose);
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
