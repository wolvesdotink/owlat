import {
	DESTINATION_PROVIDER_KEYS,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../analytics/transportOutcomeSummary';
import { evaluateEngagementGate } from './ramp/engagementGate';
import type { RampGateResult } from './ramp/gateTypes';
import type { DashboardWindow } from './deliverabilityDashboardView';

/** Route-state rows for one provider — one per stream plus the legacy row. */
const ROUTE_STATE_SCAN_LIMIT = 16;

/**
 * The cell's route-state row: the per-stream row when the controller has
 * written one, otherwise the legacy stream-less row the MTA snapshot writes.
 * Legacy rows carry no `ownShare` and must keep working (plan D1).
 */
export function pickRouteState(
	rows: readonly Doc<'deliverabilityRouteStates'>[],
	cell: DeliverabilityCell
): Doc<'deliverabilityRouteStates'> | null {
	return (
		rows.find((row) => row.stream === cell.stream) ??
		rows.find((row) => row.stream === undefined) ??
		null
	);
}

export async function readRouteStatesByProvider(
	ctx: QueryCtx,
	organizationId: string
): Promise<Map<string, Doc<'deliverabilityRouteStates'>[]>> {
	const byProvider = new Map<string, Doc<'deliverabilityRouteStates'>[]>();
	// The index is provider-keyed, so the read is too: one bounded read per
	// destination provider, shared by that provider's three streams.
	for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
		const rows = await ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', destinationProvider)
			)
			.take(ROUTE_STATE_SCAN_LIMIT); // bounded: one row per stream, plus the legacy row
		byProvider.set(destinationProvider, rows);
	}
	return byProvider;
}

/**
 * THE CELL'S TRAILING SECOND SERIES — the 30-day window that ENDS where the
 * evaluation window begins, which `dashboardWindow` makes true by construction.
 * A series that overlapped the recent window would be dragged down by the very
 * decay it exists to detect.
 *
 * ONE SUMMARY, TWO CONSUMERS, exactly as in the controller: gate 4's slow-poison
 * floor contracts for it, and the trailing-baseline evaluator's relative clauses
 * (gate 1's 1.5x rule, gate 3's unsubscribe proxy) compare against it. A young
 * cell simply has no baseline, and both hold rather than failing.
 *
 * ON UTC DAYS, WHERE THE CONTROLLER'S IS ON THE TICK'S CLOCK — the one span the
 * two readers still floor differently (see the module note). It stays that way
 * because the baseline's DISJOINTNESS from the reported window is what
 * `dashboardWindow` makes true by construction.
 */
export function trailingBaselineFor(
	ownBuckets: readonly TransportOutcomeBucket[],
	window: DashboardWindow
): TransportOutcomeSummary {
	return summarizeTransportOutcomeBuckets(ownBuckets, {
		since: window.baselineSinceDay,
		until: window.baselineUntilDay,
	});
}

/**
 * Gate 4 (engagement) for one cell, over the same rows every other view uses.
 *
 * BOTH SPANS ARE ARGUMENTS, because this gate reads both: the concurrent RATIO
 * compares the arms over the deciding window, the slow-poison FLOOR compares a
 * RECENT window against the prior baseline. One summary for both — which this
 * screen passed while it graded everything over seven days — hands the ratio a
 * week where the cron gives it a day.
 */
export function engagementGateFor(input: {
	readonly cell: DeliverabilityCell;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly ownRecent: TransportOutcomeSummary;
	readonly ownPriorBaseline: TransportOutcomeSummary;
	readonly now: number;
}): RampGateResult {
	return evaluateEngagementGate({
		cell: input.cell,
		own: input.own,
		reference: input.reference,
		ownRecent: input.ownRecent,
		ownPriorBaseline: input.ownPriorBaseline,
		now: input.now,
	});
}
