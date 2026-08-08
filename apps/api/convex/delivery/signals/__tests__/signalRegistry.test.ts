/**
 * THE REGISTRY CONTRACT (seams plan D9).
 *
 * Two claims, and the second is the one worth writing:
 *
 *  1. EVERY SOURCE DECLARES ITS ABSENCE — a behaviour, a sentence an operator
 *     can read, and the non-blocking promise plan D2 makes on every one of them.
 *  2. THE DECLARATION IS TRUE. A field saying "absent means substitute" that no
 *     test drives is a comment with a colon in it, so every source is driven
 *     with its evidence removed and its ACTUAL answer is checked against what it
 *     declared: `substitute` hands back the stand-in it named, `hold` still
 *     answers and the answer is `insufficient_data`, `omit` contributes nothing.
 *
 * The probe table is keyed by `SignalSourceKey`, so a source added to the
 * registry without a no-signal case does not compile — which is the only way a
 * gate like this survives the piece that wrote it.
 *
 * BOTH MATRIX LEGS. The ramp sources are driven through the arm the current leg
 * is about (`OWLAT_RAMP_GATE_MATRIX_MODE`), so the standalone leg proves the
 * standalone evaluators are the ones registered for a deployment with no
 * reference transport.
 */

import { describe, expect, it } from 'vitest';
import {
	isActionableDeliverabilitySignalSource,
	isDeliverabilitySignalSource,
	isOutcomeDeliverabilitySignalSource,
	type DeliverabilitySignalSource,
} from '@owlat/shared/deliverabilityRouting';
import type { RampGateResult, RampGateStatus } from '../../ramp/gateTypes';
import { arm, input, MATRIX_MODE, matrixInput } from '../../ramp/__tests__/gateFixtures';
import { GOOGLE_POSTMASTER_SIGNAL_SOURCE, type PostmasterDomainSignals } from '../postmaster';
import {
	collectRampGateSignals,
	RAMP_GATE_SIGNAL_SOURCES,
	RAMP_GATE_SIGNALS,
	type RampArm,
	type RampGateSignalSource,
} from '../rampGateSources';
import { allSignalSources, SIGNAL_SOURCES } from '../registry';
import { buildSndsGateInput, SNDS_ABSENT_SUBSTITUTION, SNDS_SIGNAL_SOURCE } from '../snds';
import {
	PROVIDER_FEED_SIGNAL_KEYS,
	RAMP_GATE_SIGNAL_KEYS,
	SIGNAL_SOURCE_KINDS,
	type SignalCollection,
	type SignalSourceKey,
} from '../types';
import {
	YAHOO_ABSENCE_SUBSTITUTE,
	YAHOO_CFL_SIGNAL_SOURCE,
	yahooComplaintSubstitution,
} from '../yahooCfl';

/** The arm this leg of the matrix is about. */
const ARM: RampArm = MATRIX_MODE === 'reference_arm' ? 'reference_arm' : 'trailing_baseline';

/** A window in which nothing was measured: no sends, no probes, no telemetry. */
function unmeasuredWindow() {
	return input({ own: arm({ sent: 0 }), ownSeeds: null, engagement: null });
}

/** A synthetic gate-4 answer, high-confidence so a re-grade is visible. */
const ENGAGEMENT_PASS: RampGateResult = {
	gate: 'engagement_ratio',
	status: 'pass',
	reason: 'within_threshold',
	measurement: {
		thresholdRate: 0,
		toleranceValuePp: null,
		ownSample: 0,
		referenceSample: null,
		minSample: 0,
		ownRate: 0,
		referenceRate: null,
	},
	confidence: 'high',
	mayJustifyIncrease: true,
};

/** A domain Google has never said anything about. */
const NO_POSTMASTER_DATA: PostmasterDomainSignals = {
	domain: 'quiet.example',
	userReportedSpamRatio: null,
	spfSuccessRatio: null,
	dkimSuccessRatio: null,
	dmarcSuccessRatio: null,
	deliveryErrorRatio: null,
	deliveryErrors: [],
	checks: [],
};

function rampProbe(source: RampGateSignalSource): SignalCollection<unknown> {
	return source.collect({ arm: ARM, input: unmeasuredWindow() });
}

/**
 * ONE NO-SIGNAL CASE PER SOURCE — the deployment that never configured it, or
 * the window that measured nothing. Exhaustive by type.
 *
 * The ramp probes are taken from `RAMP_GATE_SIGNALS` BY KEY rather than from the
 * folded array by position: the fold order is deliberately re-orderable, and a
 * positional binding would silently re-point `bounce_rate`'s probe at another
 * source the day someone re-orders it.
 */
const NO_SIGNAL: Readonly<Record<SignalSourceKey, () => SignalCollection<unknown>>> = {
	bounce_rate: () => rampProbe(RAMP_GATE_SIGNALS.bounce_rate),
	persistent_defers: () => rampProbe(RAMP_GATE_SIGNALS.persistent_defers),
	complaint_rate: () => rampProbe(RAMP_GATE_SIGNALS.complaint_rate),
	engagement_ratio: () => rampProbe(RAMP_GATE_SIGNALS.engagement_ratio),
	seed_placement: () => rampProbe(RAMP_GATE_SIGNALS.seed_placement),
	snds: () =>
		SNDS_SIGNAL_SOURCE.collect(
			buildSndsGateInput({
				enrolled: false,
				windowDays: 7,
				observations: [],
				truncated: false,
				attributed: false,
			})
		),
	yahoo_cfl: () =>
		YAHOO_CFL_SIGNAL_SOURCE.collect({ enrollmentState: 'not_started', hasCfblAddress: false }),
	google_postmaster: () => GOOGLE_POSTMASTER_SIGNAL_SOURCE.collect(NO_POSTMASTER_DATA),
};

describe('every registered source declares its absence', () => {
	it.each(allSignalSources())('$key declares a non-blocking absence', (source) => {
		expect(SIGNAL_SOURCE_KINDS).toContain(source.kind);
		// D2 in one assertion: an absent source may never block. The field is typed
		// `false`, so this pins the VALUE against a cast rather than the type.
		expect(source.absence.isBlocking).toBe(false);
		expect(source.absence.note.length).toBeGreaterThan(0);
		if (source.absence.behaviour === 'substitute') {
			expect(source.absence.substitutes.length).toBeGreaterThan(0);
		}
	});

	it('registers every key in the vocabulary, and only those', () => {
		expect(Object.keys(SIGNAL_SOURCES).sort()).toEqual(
			[...RAMP_GATE_SIGNAL_KEYS, ...PROVIDER_FEED_SIGNAL_KEYS].sort()
		);
	});

	it('keys its record by what each source calls itself', () => {
		for (const [key, source] of Object.entries(SIGNAL_SOURCES)) {
			expect(source.key).toBe(key);
		}
	});

	it('has a no-signal case for every registered source', () => {
		expect(Object.keys(NO_SIGNAL).sort()).toEqual(Object.keys(SIGNAL_SOURCES).sort());
	});
});

describe('the declared absence is what actually happens', () => {
	it.each(allSignalSources())('$key behaves as it declares when there is no signal', (source) => {
		const probe = NO_SIGNAL[source.key];
		const collected = probe();
		switch (source.absence.behaviour) {
			case 'substitute': {
				// A stand-in is live: the source hands back the absence naming it,
				// rather than a reading it does not have.
				expect(collected.available).toBe(false);
				if (collected.available) return;
				expect(collected.absence.behaviour).toBe('substitute');
				if (collected.absence.behaviour !== 'substitute') return;
				expect(collected.absence.substitutes.length).toBeGreaterThan(0);
				expect(collected.absence.isBlocking).toBe(false);
				return;
			}
			case 'omit': {
				expect(collected.available).toBe(false);
				if (collected.available) return;
				expect(collected.absence).toEqual(source.absence);
				return;
			}
			case 'hold': {
				// A holding source STILL ANSWERS: the aggregator has to weigh the hold
				// above `pass`, so an absent reading here would be the ramp advancing
				// on nothing (plan D10).
				expect(collected.available).toBe(true);
				if (!collected.available) return;
				const status: RampGateStatus = (collected.reading as RampGateResult).status;
				expect(status).toBe('insufficient_data');
				return;
			}
		}
	});
});

describe('a kind is the shared vocabulary, not a local opinion', () => {
	it.each([...RAMP_GATE_SIGNAL_KEYS])('%s is classified as shared classifies it', (key) => {
		const shared: DeliverabilitySignalSource = key;
		const expected = isOutcomeDeliverabilitySignalSource(shared)
			? 'outcome'
			: isActionableDeliverabilitySignalSource(shared)
				? 'infrastructure'
				: 'advisory';
		expect(SIGNAL_SOURCES[key].kind).toBe(expected);
	});

	it.each([...PROVIDER_FEED_SIGNAL_KEYS])('%s is advisory and is not a routing signal', (key) => {
		// A feed that could name itself in the routing vocabulary could be acted on
		// by the shipped fallback; keeping the two unions disjoint is what stops a
		// third-party account from ever flipping a provider slice onto the relay.
		expect(isDeliverabilitySignalSource(key)).toBe(false);
		expect(SIGNAL_SOURCES[key].kind).toBe('advisory');
	});

	it('nothing the ramp folds is advisory', () => {
		const advisory = allSignalSources()
			.filter((source) => source.kind === 'advisory')
			.map((source) => source.key);
		expect(advisory.sort()).toEqual([...PROVIDER_FEED_SIGNAL_KEYS].sort());
	});
});

describe('the substituted sentence is read, never restated', () => {
	it('the Microsoft absence is the substitution table entry', () => {
		expect(SNDS_SIGNAL_SOURCE.absence).toEqual({
			behaviour: 'substitute',
			substitutes: SNDS_ABSENT_SUBSTITUTION.source,
			note: SNDS_ABSENT_SUBSTITUTION.confidenceNote,
			isBlocking: false,
		});
	});

	it('an enrolled-but-silent feed is the same absence as no enrollment at all', () => {
		const silent = SNDS_SIGNAL_SOURCE.collect(
			buildSndsGateInput({
				enrolled: true,
				windowDays: 7,
				observations: [],
				truncated: false,
				attributed: true,
			})
		);
		expect(silent.available).toBe(false);
		if (silent.available) return;
		expect(silent.absence).toEqual(SNDS_SIGNAL_SOURCE.absence);
	});

	it('the yahoo absence names the stand-in that is actually live', () => {
		const proxy = yahooComplaintSubstitution({
			enrollmentState: 'not_started',
			hasCfblAddress: false,
		});
		// The stand-in is NAMED in the one substitute vocabulary the degradation
		// table and the dashboard use, and the sentence is the substitution's own.
		// A deployment with nothing configured is by definition not on the feed.
		const source = proxy.source;
		expect(source).not.toBe('yahoo_cfl');
		if (source === 'yahoo_cfl') return;
		expect(YAHOO_CFL_SIGNAL_SOURCE.absence).toEqual({
			behaviour: 'substitute',
			substitutes: YAHOO_ABSENCE_SUBSTITUTE[source],
			note: proxy.confidenceNote,
			isBlocking: false,
		});
		// The CFBL feed is a DIFFERENT stand-in, and the absence says so rather than
		// reporting the declared one: Yahoo does not serve RFC 9477 CFBL-Address.
		const withCfbl = YAHOO_CFL_SIGNAL_SOURCE.collect({
			enrollmentState: 'awaiting_yahoo',
			hasCfblAddress: true,
		});
		expect(withCfbl.available).toBe(false);
		if (withCfbl.available) return;
		expect(withCfbl.absence).toMatchObject({ substitutes: 'cfbl_address_reports' });
	});

	it('an enrolled cell is present, and a lapsed one is not', () => {
		const enrolled = YAHOO_CFL_SIGNAL_SOURCE.collect({
			enrollmentState: 'enrolled',
			hasCfblAddress: false,
		});
		expect(enrolled.available).toBe(true);
		expect(
			YAHOO_CFL_SIGNAL_SOURCE.collect({ enrollmentState: 'lapsed', hasCfblAddress: false })
				.available
		).toBe(false);
	});

	it('a connected domain with nothing failing is present with no cards', () => {
		// The distinction the `omit` absence exists to make: "nothing to report" is
		// not "no account", and only the second is an invitation to connect one.
		const quiet = GOOGLE_POSTMASTER_SIGNAL_SOURCE.collect({
			...NO_POSTMASTER_DATA,
			userReportedSpamRatio: 0,
		});
		expect(quiet.available).toBe(true);
		if (!quiet.available) return;
		expect(quiet.reading).toEqual([]);
	});
});

describe('the ramp folds the registry, in the registry’s order', () => {
	it('registers every gate exactly once', () => {
		expect(RAMP_GATE_SIGNAL_SOURCES.map((source) => source.gate)).toEqual([
			'hard_bounce',
			'deferral',
			'complaint',
			'engagement_ratio',
			'seed_placement',
		]);
	});

	it('folds the vocabulary itself, each source under the key it calls itself', () => {
		// What this pins, precisely: the fold is DERIVED from `RAMP_GATE_SIGNAL_KEYS`
		// (so the gate-order list above is that array's order, spelled out once for a
		// reader), and every record entry's own `key` agrees with the slot it sits
		// in. It is not a completeness check — a sixth key is folded automatically by
		// the derivation, a sixth key with no source does not compile, and a sixth
		// `RampGateId` nothing folds is caught by `_EveryRampGateIsFolded`.
		expect(RAMP_GATE_SIGNAL_SOURCES.map((source) => source.key)).toEqual([
			...RAMP_GATE_SIGNAL_KEYS,
		]);
	});

	it('collects the sources in gate order, omitting the unmeasured ones', () => {
		const healthy = matrixInput(MATRIX_MODE, { engagement: null });
		expect(collectRampGateSignals(ARM, healthy).map((result) => result.gate)).toEqual([
			'hard_bounce',
			'deferral',
			'complaint',
			'seed_placement',
		]);
	});

	it('places a supplied gate-4 answer fourth, between complaint and placement', () => {
		const withEngagement = matrixInput(MATRIX_MODE, { engagement: ENGAGEMENT_PASS });
		expect(collectRampGateSignals(ARM, withEngagement).map((result) => result.gate)).toEqual([
			'hard_bounce',
			'deferral',
			'complaint',
			'engagement_ratio',
			'seed_placement',
		]);
	});

	it('the standalone arm re-grades a concurrent gate-4 answer, the equipped arm does not', () => {
		const collected = RAMP_GATE_SIGNALS.engagement_ratio.collect({
			arm: ARM,
			input: matrixInput(MATRIX_MODE, { engagement: ENGAGEMENT_PASS }),
		});
		expect(collected.available).toBe(true);
		if (!collected.available) return;
		const reading = collected.reading as RampGateResult;
		// A high-confidence, increase-justifying verdict measured against a SECOND
		// ARM must not survive into a deployment that has no second arm.
		expect(reading.mayJustifyIncrease).toBe(ARM === 'reference_arm');
	});

	it('a cell with classified probes answers gate 5 with a real reading', () => {
		// The other half of gate 5's declared `hold`: the unmeasured window answers
		// `insufficient_data` (pinned by the absence suite above), and a window that
		// DID classify probes answers something else. Without this, a change that
		// made the gate hold on every window — advancing nothing, but hiding a
		// placement failure behind a hold — would pass the absence suite untouched.
		const measured = RAMP_GATE_SIGNALS.seed_placement.collect({
			arm: ARM,
			input: matrixInput(MATRIX_MODE, { engagement: null }),
		});
		expect(measured.available).toBe(true);
		if (!measured.available) return;
		expect((measured.reading as RampGateResult).status).toBe('pass');
	});
});
