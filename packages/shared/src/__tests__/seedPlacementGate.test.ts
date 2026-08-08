import { describe, expect, it } from 'vitest';
import {
	SEED_GATE_CONFIDENCE,
	SEED_MIN_OBSERVATIONS,
	SEED_REACHED_THRESHOLD,
	SEED_REFERENCE_TOLERANCE,
	summarizeSeedPlacement,
	summarizeSeedProvider,
	summarizeSeedProviderCounts,
	type SeedArmPlacementCounts,
	type SeedObservation,
	type SeedPlacement,
	type SeedTransportArm,
} from '../seedPlacement';

function observations(
	provider: SeedObservation['provider'],
	placements: readonly SeedPlacement[],
	arm: SeedTransportArm = 'own'
): SeedObservation[] {
	return placements.map((placement) => ({ provider, arm, placement }));
}

function counts(placements: readonly SeedPlacement[]): SeedArmPlacementCounts {
	const tally: Partial<Record<SeedPlacement, number>> = {};
	for (const placement of placements) tally[placement] = (tally[placement] ?? 0) + 1;
	return tally;
}

describe('seed placement roll-up', () => {
	it('keeps the published operating points on the measurement', () => {
		expect(SEED_REACHED_THRESHOLD).toBe(0.9);
		expect(SEED_REFERENCE_TOLERANCE).toBe(0.05);
		expect(SEED_GATE_CONFIDENCE).toBe('medium');
	});

	it('reports a status and observation counts, never a placement rate', () => {
		const rollup = summarizeSeedProvider(
			'gmail',
			observations('gmail', ['inbox', 'inbox', 'inbox', 'spam'])
		);
		expect(rollup.status).toBe('mixed');
		expect(rollup.sampleSize).toBe(4);
		expect(Object.keys(rollup).sort()).toEqual([
			'anyMissing',
			'confidence',
			'provider',
			'reference',
			'referenceSampleSize',
			'sampleSize',
			'status',
		]);
	});

	it('refuses a reading below the minimum sample', () => {
		const rollup = summarizeSeedProvider(
			'apple',
			observations(
				'apple',
				Array.from({ length: SEED_MIN_OBSERVATIONS - 1 }, () => 'spam' as const)
			)
		);
		expect(rollup.status).toBe('insufficient_data');
		expect(rollup.confidence).toBe('none');
	});

	it('keeps providers and transport arms independent', () => {
		const rollups = summarizeSeedPlacement([
			...observations('gmail', ['spam', 'spam', 'spam', 'spam']),
			...observations('microsoft', ['inbox', 'inbox', 'inbox', 'inbox']),
			...observations('gmail', ['inbox', 'inbox', 'inbox', 'inbox'], 'reference'),
		]);
		const byProvider = new Map(rollups.map((rollup) => [rollup.provider, rollup]));
		expect(byProvider.get('gmail')).toMatchObject({
			status: 'collapse_suspected',
			reference: 'below_reference',
		});
		expect(byProvider.get('microsoft')?.status).toBe('inbox_dominant');
	});

	it('reads counters and observations identically', () => {
		const own = ['inbox', 'inbox', 'spam', 'missing'] as const;
		const reference = ['inbox', 'inbox', 'inbox', 'inbox'] as const;
		expect(
			summarizeSeedProviderCounts('gmail', {
				own: counts(own),
				reference: counts(reference),
			})
		).toEqual(
			summarizeSeedProvider('gmail', [
				...observations('gmail', own),
				...observations('gmail', reference, 'reference'),
			])
		);
	});

	it('scrubs hostile counters before they can manufacture a sample', () => {
		const rollup = summarizeSeedProviderCounts('yahoo', {
			own: { inbox: Number.POSITIVE_INFINITY, spam: -2, missing: 2.9 },
		});
		expect(rollup.sampleSize).toBe(2);
		expect(rollup.anyMissing).toBe(true);
		expect(rollup.status).toBe('insufficient_data');
	});
});
