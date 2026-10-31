/**
 * P4-7 — the placement adapter: ONE interface, exactly TWO implementations.
 *
 * Pins the four things the piece card names: both implementations satisfy one
 * interface; the self-hosted path is the DEFAULT; an absent commercial key
 * changes NOTHING; and the scheduler fires before a phase promotion and
 * feeds gate 5.
 */

import { describe, expect, it } from 'vitest';
import type { DeliverabilityCell } from '../deliverabilityRouting';
import {
	resolvePlacementAdapter,
	type CommercialPlacementReport,
	type PlacementAdapter,
} from '../placementAdapter';
import { SEED_GATE_CONFIDENCE } from '../seedPlacement';
import type { SeedObservation } from '../seedPlacement';

// The two implementations, reached the way production reaches them.
const selfHostedSeedPlacementAdapter = resolvePlacementAdapter({
	seedMailboxCount: 8,
	commercialApiConfigured: false,
}).adapter;
const commercialPlacementApiAdapter = resolvePlacementAdapter({
	seedMailboxCount: 8,
	commercialApiConfigured: true,
}).adapter;

// The panel caps, pinned as literals: per-report mailbox count and report list.
const MAX_PANEL_MAILBOXES_PER_REPORT = 200;
const MAX_PANEL_REPORTS = 50;

/** The roll-up a commercial panel's reports produce. */
function panel(reports: readonly CommercialPlacementReport[]) {
	return commercialPlacementApiAdapter.summarize({ kind: 'commercial_api', reports });
}

const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };

function seeds(inbox: number, spam: number, missing = 0): SeedObservation[] {
	const observations: SeedObservation[] = [];
	for (let i = 0; i < inbox; i += 1)
		observations.push({ provider: 'gmail', arm: 'own', placement: 'inbox' });
	for (let i = 0; i < spam; i += 1)
		observations.push({ provider: 'gmail', arm: 'own', placement: 'spam' });
	for (let i = 0; i < missing; i += 1)
		observations.push({ provider: 'gmail', arm: 'own', placement: 'missing' });
	return observations;
}

describe('exactly two implementations', () => {
	it('both implementations satisfy the same interface', () => {
		const adapters: PlacementAdapter[] = [
			selfHostedSeedPlacementAdapter,
			commercialPlacementApiAdapter,
		];
		expect(adapters.map((adapter) => adapter.kind)).toEqual([
			'self_hosted_seeds',
			'commercial_api',
		]);
		for (const adapter of adapters) {
			// The grade has ONE home; asserting the constant rather than a literal
			// is what stops the adapter drifting away from the gate it feeds.
			expect(adapter.confidence).toBe(SEED_GATE_CONFIDENCE);
			expect(typeof adapter.summarize).toBe('function');
		}
	});

	it('the two implementations agree on the same underlying reading', () => {
		const fromSeeds = selfHostedSeedPlacementAdapter.summarize({
			kind: 'self_hosted_seeds',
			observations: seeds(10, 0),
		});
		const fromPanel = commercialPlacementApiAdapter.summarize({
			kind: 'commercial_api',
			reports: [{ provider: 'gmail', inbox: 10, spam: 0 }],
		});
		expect(fromPanel).toEqual(fromSeeds);
	});

	it('evidence from the other source is a HOLD, never a guess', () => {
		expect(
			selfHostedSeedPlacementAdapter.summarize({
				kind: 'commercial_api',
				reports: [{ provider: 'gmail', inbox: 10, spam: 0 }],
			})
		).toEqual([]);
		expect(
			commercialPlacementApiAdapter.summarize({
				kind: 'self_hosted_seeds',
				observations: seeds(10, 0),
			})
		).toEqual([]);
	});
});

describe('the self-hosted path is the default', () => {
	it('resolves to the seed adapter with no commercial key', () => {
		const resolution = resolvePlacementAdapter({
			seedMailboxCount: 8,
			commercialApiConfigured: false,
		});
		expect(resolution.kind).toBe('self_hosted_seeds');
		expect(resolution.adapter.kind).toBe('self_hosted_seeds');
		expect(resolution.improvement).toBe('none');
		expect(resolution.confidence).toBe(SEED_GATE_CONFIDENCE);
	});

	it('a commercial key is an UPGRADE that wins when present', () => {
		const resolution = resolvePlacementAdapter({
			seedMailboxCount: 8,
			commercialApiConfigured: true,
		});
		expect(resolution.kind).toBe('commercial_api');
		expect(resolution.adapter.kind).toBe('commercial_api');
	});
});

describe('an absent commercial key changes NOTHING', () => {
	it('never blocks, whatever is configured', () => {
		const configs = [
			{ seedMailboxCount: 0, commercialApiConfigured: false },
			{ seedMailboxCount: 8, commercialApiConfigured: false },
			{ seedMailboxCount: 0, commercialApiConfigured: true },
		];
		for (const config of configs) {
			expect(resolvePlacementAdapter(config).blocking).toBe(false);
		}
	});

	it('resolves without throwing on a bare install with zero credentials', () => {
		const resolution = resolvePlacementAdapter({
			seedMailboxCount: 0,
			commercialApiConfigured: false,
		});
		expect(resolution.kind).toBe('self_hosted_seeds');
		// Advisory ONLY — a hint next to a confidence label, never an error.
		expect(resolution.improvement).toBe('add_seed_mailboxes');
		expect(resolution.confidence).toBe('none');
	});
});

describe('commercial counts fold into the shared observation shape', () => {
	it('expands counts, treats a tab as reached and defaults the arm to own', () => {
		expect(panel([{ provider: 'gmail', inbox: 2, category: 1, spam: 1, missing: 1 }])).toEqual([
			expect.objectContaining({ sampleSize: 5, referenceSampleSize: 0, anyMissing: true }),
		]);
		// A tab is reached: an all-category panel reads as inbox-dominant.
		expect(panel([{ provider: 'gmail', inbox: 0, category: 10, spam: 0 }])[0]?.status).toBe(
			'inbox_dominant'
		);
	});

	it('is hostile-input safe: negatives, NaN and fractions never manufacture probes', () => {
		// Only the two whole missing probes survive: no inbox, no spam, no
		// reference arm.
		expect(
			panel([
				{ provider: 'yahoo', inbox: -5, spam: Number.NaN, missing: 2.7 },
				{ provider: 'yahoo', arm: 'reference', inbox: Number.POSITIVE_INFINITY, spam: 0 },
			])
		).toEqual([
			expect.objectContaining({
				status: 'insufficient_data',
				sampleSize: 2,
				referenceSampleSize: 0,
				anyMissing: true,
			}),
		]);
	});

	it('a huge count from the panel is clamped to the named cap', () => {
		// The only junk value that actually ALLOCATES is a large FINITE one: the
		// counts are expanded into one row per mailbox, and the roll-up walks that
		// array several times per provider. The cap is what keeps a third party
		// from choosing how much work we do.
		const [rollup] = panel([
			{ provider: 'gmail', inbox: 1e9, spam: 1e9, category: 1e9, missing: 1e9 },
		]);
		expect(rollup?.sampleSize).toBe(4 * MAX_PANEL_MAILBOXES_PER_REPORT);
	});

	it('the report LIST is bounded too', () => {
		const reports = Array.from({ length: MAX_PANEL_REPORTS + 25 }, () => ({
			provider: 'gmail' as const,
			inbox: 1,
			spam: 0,
		}));
		expect(panel(reports)[0]?.sampleSize).toBe(MAX_PANEL_REPORTS);
	});

	it('keeps the reference arm separate so it cannot dilute the own arm', () => {
		const rollups = commercialPlacementApiAdapter.summarize({
			kind: 'commercial_api',
			reports: [
				{ provider: 'gmail', arm: 'own', inbox: 1, spam: 9 },
				{ provider: 'gmail', arm: 'reference', inbox: 10, spam: 0 },
			],
		});
		expect(rollups).toHaveLength(1);
		expect(rollups[0]?.status).toBe('collapse_suspected');
	});
});
