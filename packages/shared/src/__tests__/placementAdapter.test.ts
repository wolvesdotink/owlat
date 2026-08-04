/**
 * P4-7 — the placement adapter: ONE interface, exactly TWO implementations.
 *
 * Pins the four things the piece card names: both implementations satisfy one
 * interface; the self-hosted path is the DEFAULT; an absent commercial key
 * changes NOTHING (D2); and the scheduler fires before a phase promotion and
 * feeds gate 5.
 */

import { describe, expect, it } from 'vitest';
import type { DeliverabilityCell } from '../deliverabilityRouting';
import {
	DEFAULT_PLACEMENT_SOURCE_KIND,
	MAX_PANEL_MAILBOXES_PER_REPORT,
	MAX_PANEL_REPORTS,
	PLACEMENT_PROBE_FRESHNESS_MS,
	PLACEMENT_SOURCE_KINDS,
	commercialPlacementApiAdapter,
	commercialReportsToObservations,
	evaluatePlacementGate,
	planPlacementProbeForPromotion,
	resolvePlacementAdapter,
	selfHostedSeedPlacementAdapter,
	type PlacementAdapter,
} from '../placementAdapter';
import { SEED_GATE_CONFIDENCE } from '../seedPlacement';
import type { SeedCorroboration, SeedObservation } from '../seedPlacement';

const QUIET: SeedCorroboration = { deferralGateBreached: false, bounceGateBreached: false };
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
	it('the source union is closed at two — no registry, no discovery', () => {
		expect([...PLACEMENT_SOURCE_KINDS]).toEqual(['self_hosted_seeds', 'commercial_api']);
	});

	it('both implementations satisfy the same interface', () => {
		const adapters: PlacementAdapter[] = [
			selfHostedSeedPlacementAdapter,
			commercialPlacementApiAdapter,
		];
		for (const adapter of adapters) {
			expect(PLACEMENT_SOURCE_KINDS).toContain(adapter.kind);
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
	it('names self-hosted seeds as the default kind', () => {
		expect(DEFAULT_PLACEMENT_SOURCE_KIND).toBe('self_hosted_seeds');
	});

	it('resolves to the seed adapter with no commercial key', () => {
		const resolution = resolvePlacementAdapter({
			seedMailboxCount: 8,
			commercialApiConfigured: false,
		});
		expect(resolution.kind).toBe('self_hosted_seeds');
		expect(resolution.adapter).toBe(selfHostedSeedPlacementAdapter);
		expect(resolution.improvement).toBe('none');
		expect(resolution.confidence).toBe(SEED_GATE_CONFIDENCE);
	});

	it('a commercial key is an UPGRADE that wins when present', () => {
		const resolution = resolvePlacementAdapter({
			seedMailboxCount: 8,
			commercialApiConfigured: true,
		});
		expect(resolution.kind).toBe('commercial_api');
		expect(resolution.adapter).toBe(commercialPlacementApiAdapter);
	});
});

describe('D2 — an absent commercial key changes NOTHING', () => {
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

	it('with no evidence at all gate 5 HOLDS rather than passing or failing', () => {
		const result = evaluatePlacementGate({
			adapter: resolvePlacementAdapter({ seedMailboxCount: 0, commercialApiConfigured: false })
				.adapter,
			evidence: { kind: 'self_hosted_seeds', observations: [] },
			corroboration: QUIET,
		});
		expect(result.verdict).toBe('insufficient_data');
		expect(result.reason).toBe('no_seed_mailboxes_connected');
	});
});

describe('the adapter feeds gate 5', () => {
	it('a healthy reading passes gate 5 through either source', () => {
		expect(
			evaluatePlacementGate({
				adapter: selfHostedSeedPlacementAdapter,
				evidence: { kind: 'self_hosted_seeds', observations: seeds(10, 0) },
				corroboration: QUIET,
			}).verdict
		).toBe('pass');
		expect(
			evaluatePlacementGate({
				adapter: commercialPlacementApiAdapter,
				evidence: { kind: 'commercial_api', reports: [{ provider: 'gmail', inbox: 10, spam: 0 }] },
				corroboration: QUIET,
			}).verdict
		).toBe('pass');
	});

	it('a corroborated collapse fails gate 5 through the commercial source too', () => {
		const result = evaluatePlacementGate({
			adapter: commercialPlacementApiAdapter,
			evidence: { kind: 'commercial_api', reports: [{ provider: 'gmail', inbox: 1, spam: 19 }] },
			corroboration: { deferralGateBreached: true, bounceGateBreached: false },
		});
		expect(result.verdict).toBe('fail');
		expect(result.failedProviders).toEqual(['gmail']);
	});

	it('an uncorroborated collapse holds — D17s tripwire rule is not bypassed', () => {
		const result = evaluatePlacementGate({
			adapter: commercialPlacementApiAdapter,
			evidence: { kind: 'commercial_api', reports: [{ provider: 'gmail', inbox: 1, spam: 19 }] },
			corroboration: QUIET,
		});
		expect(result.verdict).toBe('insufficient_data');
		expect(result.suspectProviders).toEqual(['gmail']);
	});
});

describe('commercial counts fold into the shared observation shape', () => {
	it('expands counts, treats a tab as reached and defaults the arm to own', () => {
		const observations = commercialReportsToObservations([
			{ provider: 'gmail', inbox: 2, category: 1, spam: 1, missing: 1 },
		]);
		expect(observations).toHaveLength(5);
		expect(observations.every((o) => o.arm === 'own')).toBe(true);
		expect(observations.filter((o) => o.placement === 'category')).toHaveLength(1);
	});

	it('is hostile-input safe: negatives, NaN and fractions never manufacture probes', () => {
		const observations = commercialReportsToObservations([
			{ provider: 'yahoo', inbox: -5, spam: Number.NaN, missing: 2.7 },
			{ provider: 'yahoo', arm: 'reference', inbox: Number.POSITIVE_INFINITY, spam: 0 },
		]);
		expect(observations).toHaveLength(2);
		expect(observations.every((o) => o.placement === 'missing')).toBe(true);
	});

	it('a huge count from the panel is clamped to the named cap', () => {
		// The only junk value that actually ALLOCATES is a large FINITE one: the
		// counts are expanded into one row per mailbox, and the roll-up walks that
		// array several times per provider. The cap is what keeps a third party
		// from choosing how much work we do.
		const observations = commercialReportsToObservations([
			{ provider: 'gmail', inbox: 1e9, spam: 1e9, category: 1e9, missing: 1e9 },
		]);
		expect(observations).toHaveLength(4 * MAX_PANEL_MAILBOXES_PER_REPORT);
		expect(MAX_PANEL_MAILBOXES_PER_REPORT).toBeLessThanOrEqual(1000);
	});

	it('the report LIST is bounded too', () => {
		const reports = Array.from({ length: MAX_PANEL_REPORTS + 25 }, () => ({
			provider: 'gmail' as const,
			inbox: 1,
			spam: 0,
		}));
		expect(commercialReportsToObservations(reports)).toHaveLength(MAX_PANEL_REPORTS);
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

describe('scheduling fires BEFORE a phase promotion', () => {
	const now = 1_800_000_000_000;

	it('schedules a probe run when a promotion is pending and nothing was measured', () => {
		const plan = planPlacementProbeForPromotion({
			cell: CELL,
			nowMs: now,
			lastProbeAtMs: null,
			promotionPending: true,
		});
		expect(plan.shouldSchedule).toBe(true);
		expect(plan.reason).toBe('promotion_pending_no_probe_yet');
		expect(plan.cellKey).toBe('campaign:gmail');
	});

	it('schedules when the last reading is older than the freshness window', () => {
		const plan = planPlacementProbeForPromotion({
			cell: CELL,
			nowMs: now,
			lastProbeAtMs: now - PLACEMENT_PROBE_FRESHNESS_MS - 1,
			promotionPending: true,
		});
		expect(plan.shouldSchedule).toBe(true);
		expect(plan.reason).toBe('promotion_pending_probe_stale');
	});

	it('does not schedule on a fresh reading or with no promotion pending', () => {
		expect(
			planPlacementProbeForPromotion({
				cell: CELL,
				nowMs: now,
				lastProbeAtMs: now - 1000,
				promotionPending: true,
			}).reason
		).toBe('probe_fresh');
		expect(
			planPlacementProbeForPromotion({
				cell: CELL,
				nowMs: now,
				lastProbeAtMs: null,
				promotionPending: false,
			}).reason
		).toBe('no_promotion_pending');
	});

	it('D2 — a probe that cannot run NEVER blocks the promotion', () => {
		for (const promotionPending of [true, false]) {
			for (const lastProbeAtMs of [null, now, now - PLACEMENT_PROBE_FRESHNESS_MS - 1]) {
				expect(
					planPlacementProbeForPromotion({
						cell: CELL,
						nowMs: now,
						lastProbeAtMs,
						promotionPending,
					}).blocksPromotion
				).toBe(false);
			}
		}
	});

	it('clock skew cannot manufacture probe traffic', () => {
		const plan = planPlacementProbeForPromotion({
			cell: CELL,
			nowMs: now,
			// A reading stamped in the future (skewed writer) reads as fresh.
			lastProbeAtMs: now + 60 * 60 * 1000,
			promotionPending: true,
		});
		expect(plan.shouldSchedule).toBe(false);
		expect(plan.reason).toBe('probe_fresh');
	});

	it('a non-finite timestamp is treated as "never measured", not as a hold', () => {
		const plan = planPlacementProbeForPromotion({
			cell: CELL,
			nowMs: now,
			lastProbeAtMs: Number.NaN,
			promotionPending: true,
		});
		expect(plan.reason).toBe('promotion_pending_no_probe_yet');
	});

	it('an UNREADABLE clock schedules the probe rather than silently skipping it', () => {
		// With a NaN `nowMs` the age is NaN and every comparison is false, so an
		// unguarded implementation reports `probe_fresh` — a broken clock would
		// promote the cell on evidence of unknown age and gate 5 would never see a
		// fresh reading.
		for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const plan = planPlacementProbeForPromotion({
				cell: CELL,
				nowMs,
				lastProbeAtMs: now - 1000,
				promotionPending: true,
			});
			expect(plan.shouldSchedule).toBe(true);
			expect(plan.reason).toBe('promotion_pending_no_probe_yet');
		}
	});
});
