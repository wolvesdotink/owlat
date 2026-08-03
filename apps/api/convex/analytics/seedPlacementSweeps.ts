/**
 * Seed placement, PER RAMP CELL — the counted sweeps gate 5 evaluates.
 *
 * A domain sibling of `analytics/seedPlacement.ts` (the ledger owner) for the
 * same reason `seedAccounts.ts` and `seedProbeLedger.ts` are: size, and one
 * subject per file. This one holds the PURE reduction from probe rows to the
 * two counted sweeps a cell has — its own arm and, where a reference transport
 * carried probes, the yardstick arm.
 *
 * WHY IT EXISTS AT ALL. The roll-up in `@owlat/shared/seedPlacement` answers
 * "how is this MAILBOX PROVIDER doing" — a STATUS per provider, pooled across
 * streams. The ramp controller asks a narrower question: how did the probes for
 * THIS CELL land, where a cell is `(stream, destinationProvider)`. Both
 * questions are answered from the same ledger rows through the same evidence
 * rule below, so the screen's provider roll-up and the controller's per-cell
 * verdict cannot be derived from two different reads (ADR-0042 / plan D5).
 *
 * COUNTS, NEVER A RATE (plan D17). Nothing here divides. The sweeps are integers
 * per placement; the reached share is the shared module's to compute, once.
 *
 * PURE: `now` never enters, no database handle, no clock. The caller reads the
 * window (`analytics/seedPlacement.ts`) and hands the rows over.
 *
 * WHAT IT CANNOT ANSWER YET. Every probe the shadow copy writes is a CAMPAIGN
 * probe, so the transactional and automation cells of a provider have no
 * evidence here and gate 5 holds on them — honestly, and without borrowing the
 * campaign cell's sweep. The scheduled transactional probe that would close it
 * is tracked in issue #500.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
	type DeliverabilityCellKey,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import {
	SEED_PLACEMENTS,
	type SeedPlacement,
	type SeedTransportArm,
} from '@owlat/shared/seedPlacement';
import type { Doc } from '../_generated/dataModel';
import type { SeedPlacementObservation } from '../delivery/ramp/gateTypes';

/** The two arms a cell can have evidence for. `null` is ABSENT, never zeroed. */
export interface SeedCellSweeps {
	readonly own: SeedPlacementObservation | null;
	readonly reference: SeedPlacementObservation | null;
}

/** Counted sweeps for every cell that has any, keyed by the canonical cell key. */
export type SeedPlacementSweepIndex = ReadonlyMap<DeliverabilityCellKey, SeedCellSweeps>;

/**
 * A cell with no classified probes in the window. ABSENT on both arms — not a
 * sweep of zeroes, which the gate would read as a thin sample rather than as no
 * sample, and which would put a cell that has never been probed and a cell whose
 * probes all vanished into the same bucket.
 */
const NO_SWEEPS: SeedCellSweeps = { own: null, reference: null };

/**
 * ONE classified probe, as evidence — or `null` when the row is not evidence at
 * all.
 *
 * THE ONE PLACE THE LEDGER'S READING RULES LIVE, because both consumers apply
 * exactly these and a second copy is a second answer:
 *
 *   - an UNCLASSIFIED probe (no `placement`) is not evidence in either
 *     direction. It has been mailed, or is waiting to be, and the poller has not
 *     reported yet; counting it as anything would invent an observation.
 *   - a probe with NO RECORDED ARM reads as `own`. Standalone is the default
 *     configuration and s === 1 means every probe went through our own MTA.
 *   - `observedAt` is when the observation was MADE, not when the probe was
 *     sent. A classified row always carries `classifiedAt`; the `sentAt`
 *     fallback exists for a row written before that stamp did, and it can only
 *     be OLDER — so it can only make a sweep look stale, never fresh, which is
 *     the safe direction for every freshness rule downstream.
 */
export interface SeedProbeEvidence {
	readonly provider: DestinationProviderKey;
	readonly stream: Doc<'seedPlacementProbes'>['stream'];
	readonly arm: SeedTransportArm;
	readonly placement: SeedPlacement;
	readonly observedAt: number;
}

export function seedProbeEvidence(probe: Doc<'seedPlacementProbes'>): SeedProbeEvidence | null {
	const placement = probe.placement;
	if (placement === undefined) return null;
	return {
		provider: probe.provider,
		stream: probe.stream,
		arm: probe.transportArm ?? 'own',
		placement,
		observedAt: probe.classifiedAt ?? probe.sentAt,
	};
}

interface SweepAccumulator {
	readonly counts: Partial<Record<SeedPlacement, number>>;
	probes: number;
	observedAt: number;
}

function emptyAccumulator(): SweepAccumulator {
	return { counts: {}, probes: 0, observedAt: 0 };
}

/**
 * An arm nothing landed on is ABSENT, not a sweep of zeroes: the gate reads a
 * zeroed sweep as a thin sample and an absent one as no sample, and a cell that
 * has never been probed is the second thing.
 */
function finish(accumulator: SweepAccumulator): SeedPlacementObservation | null {
	if (accumulator.probes === 0) return null;
	const counts: Partial<Record<SeedPlacement, number>> = {};
	for (const placement of SEED_PLACEMENTS) counts[placement] = accumulator.counts[placement] ?? 0;
	return { ...counts, observedAt: accumulator.observedAt };
}

/**
 * Reduce a window of probe rows to one counted sweep per (cell, arm).
 *
 * The sweep's `observedAt` is the NEWEST classification in it, so a cell that
 * stopped being probed goes stale by the ramp's ordinary freshness rule instead
 * of carrying an old verdict forward on the strength of one recent row.
 */
export function buildSeedPlacementSweeps(
	probes: readonly Doc<'seedPlacementProbes'>[]
): SeedPlacementSweepIndex {
	const byCell = new Map<DeliverabilityCellKey, Record<SeedTransportArm, SweepAccumulator>>();
	for (const probe of probes) {
		const evidence = seedProbeEvidence(probe);
		if (evidence === null) continue;
		const key = deliverabilityCellKey({
			stream: evidence.stream,
			destinationProvider: evidence.provider,
		});
		let arms = byCell.get(key);
		if (arms === undefined) {
			arms = { own: emptyAccumulator(), reference: emptyAccumulator() };
			byCell.set(key, arms);
		}
		const accumulator = arms[evidence.arm];
		accumulator.counts[evidence.placement] = (accumulator.counts[evidence.placement] ?? 0) + 1;
		accumulator.probes += 1;
		accumulator.observedAt = Math.max(accumulator.observedAt, evidence.observedAt);
	}

	const index = new Map<DeliverabilityCellKey, SeedCellSweeps>();
	for (const [key, arms] of byCell) {
		index.set(key, { own: finish(arms.own), reference: finish(arms.reference) });
	}
	return index;
}

/**
 * This cell's sweeps, with ABSENCE as the answer for a cell the ledger has
 * nothing for — the default and supported configuration (plan D2), and the one
 * place that default is spelled.
 */
export function seedSweepsForCell(
	index: SeedPlacementSweepIndex,
	cell: DeliverabilityCell
): SeedCellSweeps {
	return index.get(deliverabilityCellKey(cell)) ?? NO_SWEEPS;
}
