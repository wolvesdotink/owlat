import { describe, it, expect } from 'vitest';
import {
	evaluateSeedPlacementGate,
	resolveSeedTripwire,
	SEED_MIN_OBSERVATIONS,
	summarizeSeedPlacement,
	summarizeSeedProvider,
	type SeedObservation,
	type SeedPlacement,
	type SeedProviderRollup,
} from '@owlat/shared/seedPlacement';

const NO_CORROBORATION = { deferralGateBreached: false, bounceGateBreached: false };

function observations(
	provider: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other',
	placements: SeedPlacement[]
): SeedObservation[] {
	return placements.map((placement) => ({ provider, placement }));
}

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
		expect(keys).toEqual(['anyMissing', 'confidence', 'provider', 'sampleSize', 'status']);
		// sampleSize is a count of MAILBOXES (the honesty input for
		// insufficient_data), never a placement measurement.
		expect(rollup.sampleSize).toBe(4);
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

	it('passes an uncorroborated collapse but SURFACES it as suspect', () => {
		const result = evaluateSeedPlacementGate({
			rollups: [collapsed, healthy],
			corroboration: NO_CORROBORATION,
		});
		expect(result.verdict).toBe('pass');
		expect(result.suspectProviders).toEqual(['gmail']);
		expect(result.failedProviders).toEqual([]);
		expect(result.reason).toContain('awaiting_corroboration');
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
		expect(
			evaluateSeedPlacementGate({ rollups: [flood], corroboration: NO_CORROBORATION }).verdict
		).toBe('pass');
	});

	it('is deterministic — the same observations always yield the same verdict', () => {
		const input = observations('gmail', ['inbox', 'spam', 'missing', 'category']);
		expect(summarizeSeedPlacement(input)).toEqual(summarizeSeedPlacement(input));
	});
});
