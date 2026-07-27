import { describe, it, expect } from 'vitest';
import {
	evaluateSeedPlacementGate,
	resolveSeedTripwire,
	SEED_COLLAPSE_THRESHOLD,
	SEED_MIN_OBSERVATIONS,
	SEED_REACHED_THRESHOLD,
	SEED_REFERENCE_TOLERANCE,
	summarizeSeedPlacement,
	summarizeSeedProvider,
	type SeedObservation,
	type SeedPlacement,
	type SeedProviderRollup,
	type SeedTransportArm,
} from '@owlat/shared/seedPlacement';

const NO_CORROBORATION = { deferralGateBreached: false, bounceGateBreached: false };

function observations(
	provider: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other',
	placements: SeedPlacement[],
	arm: SeedTransportArm = 'own'
): SeedObservation[] {
	return placements.map((placement) => ({ provider, arm, placement }));
}

/**
 * The plan's signal table states gate 5 as `inbox >= 90 % and >= ref - 5 pp`.
 * Pinned against the exported CONSTANTS rather than against a copy of their
 * values, so a silent retune of an operating point fails here first.
 */
describe('gate 5 operating points match the plan', () => {
	it('reaches healthy at the plan s 90 %', () => {
		expect(SEED_REACHED_THRESHOLD).toBe(0.9);
	});

	it('compares against the reference arm with the plan s 5 pp tolerance', () => {
		expect(SEED_REFERENCE_TOLERANCE).toBe(0.05);
	});

	it('derives collapse from "a MAJORITY did not reach", not from a tuned number', () => {
		expect(SEED_COLLAPSE_THRESHOLD).toBe(0.5);
	});

	it('reads exactly the reached threshold as healthy, and one probe less as not', () => {
		// 9 of 10 reached is exactly SEED_REACHED_THRESHOLD.
		const atThreshold = summarizeSeedProvider(
			'gmail',
			observations('gmail', [...Array.from({ length: 9 }, () => 'inbox' as SeedPlacement), 'spam'])
		);
		expect(atThreshold.status).toBe('inbox_dominant');
		const belowThreshold = summarizeSeedProvider(
			'gmail',
			observations('gmail', [
				...Array.from({ length: 8 }, () => 'inbox' as SeedPlacement),
				'spam',
				'spam',
			])
		);
		expect(belowThreshold.status).toBe('mixed');
	});

	it('reads exactly half reached as mixed, and a minority reached as a collapse', () => {
		const half = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'inbox', 'spam', 'spam'])
		);
		expect(half.status).toBe('mixed');
		const minority = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'spam', 'spam', 'spam'])
		);
		expect(minority.status).toBe('collapse_suspected');
	});
});

/** (c) The roll-up exposes a STATUS, never a number. */
describe('the roll-up is a status, not a gauge (D17)', () => {
	const rollup = summarizeSeedProvider(
		'gmail',
		observations('gmail', ['inbox', 'inbox', 'inbox', 'inbox'])
	);

	it('reports a status', () => {
		expect(rollup.status).toBe('inbox_dominant');
	});

	it('exposes no rate, percentage, or per-placement count anyone could quote', () => {
		const keys = Object.keys(rollup).sort();
		expect(keys).toEqual([
			'anyMissing',
			'confidence',
			'provider',
			'reference',
			'referenceSampleSize',
			'sampleSize',
			'status',
		]);
		// sampleSize / referenceSampleSize are counts of OBSERVATIONS (the honesty
		// input for insufficient_data), never a placement measurement, and
		// `reference` is a status rather than the pp gap it is derived from.
		expect(rollup.sampleSize).toBe(4);
		expect(rollup.reference).toBe('no_reference_arm');
	});

	it('never claims more than low confidence — seeds are a weak signal and say so', () => {
		expect(rollup.confidence).toBe('low');
	});

	it('flags a probe that vanished, the outcome no other signal surfaces', () => {
		const withMissing = summarizeSeedProvider(
			'yahoo',
			observations('yahoo', ['inbox', 'inbox', 'missing'])
		);
		expect(withMissing.anyMissing).toBe(true);
		expect(rollup.anyMissing).toBe(false);
	});

	it('refuses a verdict below the minimum sample and never nudges either way', () => {
		const thin = summarizeSeedProvider(
			'apple',
			observations(
				'apple',
				Array.from({ length: SEED_MIN_OBSERVATIONS - 1 }, () => 'spam' as SeedPlacement)
			)
		);
		expect(thin.status).toBe('insufficient_data');
		expect(thin.confidence).toBe('none');
	});

	it('rolls up each provider independently', () => {
		const rollups = summarizeSeedPlacement([
			...observations('gmail', ['inbox', 'inbox', 'inbox']),
			...observations('microsoft', ['spam', 'spam', 'spam']),
		]);
		const byProvider = new Map(rollups.map((r) => [r.provider, r.status]));
		expect(byProvider.get('gmail')).toBe('inbox_dominant');
		expect(byProvider.get('microsoft')).toBe('collapse_suspected');
	});

	it('reads a partial slide as mixed, not a collapse', () => {
		const mixed = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'inbox', 'spam', 'missing'])
		);
		expect(mixed.status).toBe('mixed');
	});

	it('reads MOSTLY spam as a collapse even when one probe still lands (D17)', () => {
		// 7-of-8 in spam is plainly "mostly spam"; an all-or-nothing detector
		// would miss it entirely. The corroboration gate, not the detector, is
		// what protects the eight-mailbox case.
		const mostlySpam = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'spam', 'spam', 'spam', 'spam', 'spam', 'spam', 'spam'])
		);
		expect(mostlySpam.status).toBe('collapse_suspected');
	});

	it('treats a probe the provider auto-deleted as NOT reaching the mailbox', () => {
		const binned = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['deleted', 'deleted', 'deleted'])
		);
		expect(binned.status).toBe('collapse_suspected');
	});

	it('treats a Gmail tab as reaching the mailbox', () => {
		const tabbed = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['category', 'category', 'category'])
		);
		expect(tabbed.status).toBe('inbox_dominant');
	});
});

/** (c) A provider-wide collapse requires corroboration before it can act. */
describe('the corroboration rule (D17)', () => {
	const collapsed: SeedProviderRollup = summarizeSeedProvider(
		'gmail',
		observations('gmail', ['spam', 'spam', 'spam', 'missing', 'spam', 'spam', 'spam', 'spam'])
	);

	it('detects the collapse', () => {
		expect(collapsed.status).toBe('collapse_suspected');
	});

	it('HOLDS on a collapse with no corroboration — eight mailboxes may not halve a healthy share', () => {
		expect(resolveSeedTripwire(collapsed, NO_CORROBORATION)).toEqual({
			action: 'hold',
			reason: 'seed_collapse_awaiting_corroboration',
		});
	});

	it('acts when the DEFERRAL gate corroborates', () => {
		expect(
			resolveSeedTripwire(collapsed, { deferralGateBreached: true, bounceGateBreached: false })
		).toEqual({ action: 'act', reason: 'seed_collapse_corroborated' });
	});

	it('acts when the BOUNCE gate corroborates', () => {
		expect(
			resolveSeedTripwire(collapsed, { deferralGateBreached: false, bounceGateBreached: true })
		).toEqual({ action: 'act', reason: 'seed_collapse_corroborated' });
	});

	it('never acts on a healthy, mixed, or thin reading — even with both gates breached', () => {
		const both = { deferralGateBreached: true, bounceGateBreached: true };
		for (const rollup of [
			summarizeSeedProvider('gmail', observations('gmail', ['inbox', 'inbox', 'inbox'])),
			summarizeSeedProvider('gmail', observations('gmail', ['inbox', 'inbox', 'spam', 'spam'])),
			summarizeSeedProvider('gmail', observations('gmail', ['spam'])),
		]) {
			expect(resolveSeedTripwire(rollup, both).action).toBe('hold');
		}
	});
});

/** (c) MISSING is the most alarming outcome — and it is load-bearing. */
describe('a degraded provider that is also LOSING probes', () => {
	const missingMixed = summarizeSeedProvider(
		'gmail',
		observations('gmail', ['inbox', 'inbox', 'spam', 'missing'])
	);

	it('is mixed, and records that a probe vanished', () => {
		expect(missingMixed.status).toBe('mixed');
		expect(missingMixed.anyMissing).toBe(true);
	});

	it('HOLDS while nothing corroborates it', () => {
		expect(resolveSeedTripwire(missingMixed, NO_CORROBORATION)).toEqual({
			action: 'hold',
			reason: 'seed_probes_missing_awaiting_corroboration',
		});
	});

	it('acts once the bounce gate corroborates', () => {
		expect(
			resolveSeedTripwire(missingMixed, { deferralGateBreached: false, bounceGateBreached: true })
		).toEqual({ action: 'act', reason: 'seed_probes_missing_corroborated' });
	});

	it('stays a plain hold when the same mix loses no probes', () => {
		const noMissing = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'inbox', 'spam', 'spam'])
		);
		expect(
			resolveSeedTripwire(noMissing, { deferralGateBreached: true, bounceGateBreached: true })
		).toEqual({ action: 'hold', reason: 'seeds_mixed_no_collapse' });
	});
});

describe('gate 5 verdicts', () => {
	const collapsed = summarizeSeedProvider(
		'gmail',
		observations('gmail', ['spam', 'spam', 'spam', 'spam'])
	);
	const healthy = summarizeSeedProvider(
		'microsoft',
		observations('microsoft', ['inbox', 'inbox', 'inbox'])
	);

	it('HOLDS an uncorroborated collapse, naming the suspect — it may not license an increase', () => {
		// `pass` would be wrong in the dangerous direction: the controller counts a
		// passing gate towards the K_CLEAN streak that authorises an additive
		// increase, so a green gate 5 here would ramp the share UP while every seed
		// mailbox is being filtered to spam. `insufficient_data` HOLDS: neither up
		// nor down.
		const result = evaluateSeedPlacementGate({
			rollups: [collapsed, healthy],
			corroboration: NO_CORROBORATION,
		});
		expect(result.verdict).toBe('insufficient_data');
		expect(result.suspectProviders).toEqual(['gmail']);
		expect(result.failedProviders).toEqual([]);
		expect(result.reason).toContain('awaiting_corroboration');
		expect(result.reason).toContain('gmail');
	});

	it('fails, naming the provider, once corroborated', () => {
		const result = evaluateSeedPlacementGate({
			rollups: [collapsed, healthy],
			corroboration: { deferralGateBreached: true, bounceGateBreached: false },
		});
		expect(result.verdict).toBe('fail');
		expect(result.failedProviders).toEqual(['gmail']);
		expect(result.reason).toContain('gmail');
	});

	it('passes cleanly when every provider is reaching the mailbox', () => {
		const result = evaluateSeedPlacementGate({
			rollups: [healthy],
			corroboration: { deferralGateBreached: true, bounceGateBreached: true },
		});
		expect(result.verdict).toBe('pass');
		expect(result.reason).toBe('seeds_reaching_inbox');
	});

	it('holds on thin data no matter how alarming it looks (D10)', () => {
		const thin = summarizeSeedProvider('yahoo', observations('yahoo', ['missing', 'missing']));
		const result = evaluateSeedPlacementGate({
			rollups: [thin],
			corroboration: { deferralGateBreached: true, bounceGateBreached: true },
		});
		expect(result.verdict).toBe('insufficient_data');
		expect(result.confidence).toBe('none');
	});
});

/**
 * Gate 5's SECOND clause. The plan states the gate as `inbox >= 90 % and
 * >= ref - 5 pp`; with a reference transport connected the comparison has to
 * happen, and it has to happen PER ARM — pooling the two would let reference
 * probes landing fine dilute an own-arm degradation, which is the exact failure
 * the gate exists to catch.
 */
describe('the per-arm roll-up and the reference comparison', () => {
	const reached = (n: number): SeedPlacement[] =>
		Array.from({ length: n }, () => 'inbox' as SeedPlacement);
	const filtered = (n: number): SeedPlacement[] =>
		Array.from({ length: n }, () => 'spam' as SeedPlacement);

	it('reads status, sample and anyMissing off the OWN arm only', () => {
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', [...filtered(3), 'missing'], 'own'),
			...observations('gmail', reached(10), 'reference'),
		]);
		expect(rollup.status).toBe('collapse_suspected');
		expect(rollup.sampleSize).toBe(4);
		expect(rollup.anyMissing).toBe(true);
		expect(rollup.referenceSampleSize).toBe(10);
	});

	it('OWN degraded vs REFERENCE clean reads as below_reference and can FAIL once corroborated', () => {
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', [...reached(2), ...filtered(2)], 'own'),
			...observations('gmail', reached(10), 'reference'),
		]);
		expect(rollup.reference).toBe('below_reference');
		expect(resolveSeedTripwire(rollup, NO_CORROBORATION)).toEqual({
			action: 'hold',
			reason: 'seeds_below_reference_awaiting_corroboration',
		});
		const corroborated = evaluateSeedPlacementGate({
			rollups: [rollup],
			corroboration: { deferralGateBreached: true, bounceGateBreached: false },
		});
		expect(corroborated.verdict).toBe('fail');
		expect(corroborated.failedProviders).toEqual(['gmail']);
	});

	it('trips the second clause even when the ABSOLUTE clause is comfortably clean', () => {
		// 9 of 10 own-arm probes reach — `inbox_dominant` — but the reference arm
		// reaches every time, so the own arm is 10 pp behind and the plan's
		// `>= ref - 5 pp` clause is breached.
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', [...reached(9), 'spam'], 'own'),
			...observations('gmail', reached(10), 'reference'),
		]);
		expect(rollup.status).toBe('inbox_dominant');
		expect(rollup.reference).toBe('below_reference');
		expect(
			resolveSeedTripwire(rollup, { deferralGateBreached: true, bounceGateBreached: false }).action
		).toBe('act');
	});

	it('stays within tolerance when the own arm trails the reference only slightly', () => {
		// 19 of 20 vs 20 of 20 is a 5 pp gap — exactly the tolerance, so it passes.
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', [...reached(19), 'spam'], 'own'),
			...observations('gmail', reached(20), 'reference'),
		]);
		expect(rollup.reference).toBe('at_or_above_reference');
		expect(resolveSeedTripwire(rollup, NO_CORROBORATION)).toEqual({
			action: 'hold',
			reason: 'seeds_reaching_inbox',
		});
	});

	it('BOTH arms degraded — the absolute clause decides, not the comparison', () => {
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', filtered(4), 'own'),
			...observations('gmail', filtered(4), 'reference'),
		]);
		expect(rollup.reference).toBe('at_or_above_reference');
		expect(rollup.status).toBe('collapse_suspected');
		expect(
			resolveSeedTripwire(rollup, { deferralGateBreached: false, bounceGateBreached: true })
		).toEqual({ action: 'act', reason: 'seed_collapse_corroborated' });
	});

	it('holds the comparison when the reference arm is below the minimum sample (D10)', () => {
		const rollup = summarizeSeedProvider('gmail', [
			...observations('gmail', [...reached(2), ...filtered(2)], 'own'),
			...observations('gmail', reached(SEED_MIN_OBSERVATIONS - 1), 'reference'),
		]);
		expect(rollup.reference).toBe('insufficient_reference_sample');
		expect(
			resolveSeedTripwire(rollup, { deferralGateBreached: true, bounceGateBreached: true }).action
		).toBe('hold');
	});
});

/**
 * THE STANDALONE MATRIX (D3's substitution). The same fixtures with NO
 * reference arm at all: the second clause is simply absent, the absolute clause
 * is the whole gate, and nothing errors, warns, or reads differently in kind.
 */
describe('the same matrix with no reference arm (standalone)', () => {
	const cases: Array<{
		name: string;
		placements: SeedPlacement[];
		status: string;
		action: 'hold' | 'act';
	}> = [
		{
			name: 'clean',
			placements: ['inbox', 'inbox', 'inbox', 'inbox'],
			status: 'inbox_dominant',
			action: 'hold',
		},
		{
			name: 'degraded',
			placements: ['inbox', 'inbox', 'spam', 'spam'],
			status: 'mixed',
			action: 'hold',
		},
		{
			name: 'degraded and losing probes',
			placements: ['inbox', 'inbox', 'spam', 'missing'],
			status: 'mixed',
			action: 'act',
		},
		{
			name: 'collapsed',
			placements: ['spam', 'spam', 'spam', 'spam'],
			status: 'collapse_suspected',
			action: 'act',
		},
	];

	for (const testCase of cases) {
		it(`${testCase.name}: no reference arm, and the absolute clause decides`, () => {
			const rollup = summarizeSeedProvider('gmail', observations('gmail', testCase.placements));
			expect(rollup.reference).toBe('no_reference_arm');
			expect(rollup.referenceSampleSize).toBe(0);
			expect(rollup.status).toBe(testCase.status);
			expect(
				resolveSeedTripwire(rollup, { deferralGateBreached: true, bounceGateBreached: true }).action
			).toBe(testCase.action);
		});
	}

	it('never reads `below_reference` when nothing carried a reference probe', () => {
		for (const testCase of cases) {
			const rollup = summarizeSeedProvider('gmail', observations('gmail', testCase.placements));
			expect(rollup.reference).not.toBe('below_reference');
		}
	});
});

/** Adversarial: degenerate and hostile inputs must not produce a verdict. */
describe('adversarial inputs', () => {
	it('survives an empty observation set without dividing by zero', () => {
		expect(summarizeSeedPlacement([])).toEqual([]);
		const result = evaluateSeedPlacementGate({ rollups: [], corroboration: NO_CORROBORATION });
		expect(result.verdict).toBe('insufficient_data');
	});

	it('cannot be pushed to a fail verdict by volume alone without corroboration', () => {
		const flood = summarizeSeedProvider(
			'gmail',
			observations(
				'gmail',
				Array.from({ length: 500 }, () => 'spam' as SeedPlacement)
			)
		);
		const result = evaluateSeedPlacementGate({
			rollups: [flood],
			corroboration: NO_CORROBORATION,
		});
		expect(result.verdict).not.toBe('fail');
		// And it does not become a PASS either — 500 spam readings are a reason to
		// doubt, so the gate holds until something corroborates them.
		expect(result.verdict).toBe('insufficient_data');
		expect(result.suspectProviders).toEqual(['gmail']);
	});

	it('is deterministic — the same observations always yield the same verdict', () => {
		const input = observations('gmail', ['inbox', 'spam', 'missing', 'category']);
		expect(summarizeSeedPlacement(input)).toEqual(summarizeSeedPlacement(input));
	});
});
