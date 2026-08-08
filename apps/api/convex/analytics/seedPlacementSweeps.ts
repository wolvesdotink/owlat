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
 * WHERE EACH STREAM'S PROBES COME FROM, because the sweeps are only as
 * comparable as their producers. The `campaign` cells are measured by a SHADOW
 * of a real send (`delivery/seedShadowCopy.ts`) — same bytes as a subscriber's
 * copy. The `transactional` and `automation` cells are measured by a SCHEDULED
 * probe (`delivery/seedScheduledProbe.ts`) carrying a fixed neutral body,
 * because those streams have no bulk transaction to clone from. Same cell axis,
 * same evidence rule, same reduction; the CONTENT behind a non-campaign sweep is
 * synthetic, which is why placement stays a tripwire for collapse (D17) rather
 * than a content-quality gauge. A cell whose stream is never probed still holds,
 * and still does not borrow another stream's sweep.
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
 * ONE classified probe, reduced to the four facts a sweep counts it by.
 *
 * MODULE-LOCAL: it names `seedProbeEvidence`'s return, and both callers — the
 * per-cell sweeps below and the provider roll-up in `analytics/seedPlacement.ts`
 * — read fields off the value rather than the name. Exporting a shape nobody
 * imports is the declared-and-unread seam this wave is closing.
 */
interface SeedProbeEvidence {
	readonly provider: DestinationProviderKey;
	readonly stream: Doc<'seedPlacementProbes'>['stream'];
	readonly arm: SeedTransportArm;
	readonly placement: SeedPlacement;
	readonly observedAt: number;
}

/**
 * One probe row as evidence — or `null` when the row is not evidence at all.
 *
 * THE ONE PLACE THE READING RULES FOR A COUNTED SWEEP LIVE. Both summarizers —
 * the per-provider roll-up in `analytics/seedPlacement.ts` and the per-cell
 * sweeps below — apply exactly these, and a second copy is a second answer to
 * "how did the probes land":
 *
 *   - an UNCLASSIFIED probe (no `placement`) is not evidence in either
 *     direction. It has been mailed, or is waiting to be, and the poller has not
 *     reported yet; counting it as anything would invent an observation.
 *   - a probe with NO RECORDED ARM reads as `own`. Standalone is the default
 *     configuration and s === 1 means every probe went through our own MTA.
 *   - `observedAt` is when the observation was MADE, not when the probe was
 *     sent. `classifiedAt` is `v.optional` in the schema, so the READ has to be
 *     total whatever the writer guarantees — the fallback is what makes it so,
 *     not a legacy row it is bridging. `sentAt` can only be OLDER, so it can
 *     only make a sweep look stale, never fresh, which is the safe direction for
 *     every freshness rule downstream.
 *
 * NOT THE ONLY READER OF THE TABLE, and deliberately not its rule. `delivery/
 * rampPromotionEvidence.ts`'s `latestSeedProbePassAt` walks the same rows with
 * its own inline test because it asks a different question — WHEN did a probe
 * last land clean, an instant used as promotion evidence, rather than how a
 * counted sweep landed. It therefore requires a real `classifiedAt` and takes no
 * `sentAt` fallback: an unclassified-but-sent probe is not a moment anything was
 * observed, whereas here it only makes a window look older than it is. Nothing
 * diverges today, and the two must not be collapsed on the assumption that they
 * agree — they answer different questions and would answer them differently if
 * the writer ever stopped setting `classifiedAt` alongside `placement`.
 */
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
 * THE COUNTS SPAN THE WHOLE WINDOW; THE STAMP IS THE NEWEST ROW. A sweep counts
 * every classified probe the caller's window read handed over — up to
 * `SEED_PLACEMENT_WINDOW_MS` of them — and its `observedAt` is the most recent
 * classification among them, so ONE fresh probe keeps a week-old sweep this side
 * of the ramp's staleness cascade and the gate decides on all of it. That is the
 * declared window deciding, not an accident of the reduction: anchoring the
 * stamp on the OLDEST row would make a cell probed every hour read as stale,
 * which is the one thing a freshness rule must not do. What ages out here is a
 * cell that STOPPED being probed — nothing renews the stamp, the whole sweep
 * goes stale, and gate 5 holds.
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
