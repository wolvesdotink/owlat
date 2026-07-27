/**
 * Deliverability route-state lookup (the D1 resolution seam).
 *
 * One place that knows how a `(stream, destinationProvider)` ramp cell maps
 * onto `deliverabilityRouteStates` rows, so the stream widening cannot fork
 * into per-caller lookup rules.
 *
 * A cell has TWO rows, not one, and they have DIFFERENT WRITERS:
 *
 *  - the per-stream row is the ramp controller's, carrying `ownShare` (absent
 *    until P3-2 writes one);
 *  - the stream-less row is the MTA snapshot's, carrying the infrastructure
 *    verdict (`isFallbackActive`) and its `signals`, and it is also the LEGACY
 *    shape every row written before the migration has.
 *
 * So `loadRouteStateCell` returns BOTH. "Per-stream else stream-less" is the
 * SHARE resolution (`perStream ?? streamless`) and nothing more: collapsing the
 * two rows at lookup time would let an empty per-stream row shadow the
 * infrastructure signals for that provider, and a critical DNSBL listing or an
 * open breaker would stop being read until the controller's next tick.
 *
 * Share resolution itself lives in `@owlat/shared/deliverabilityRouting`
 * (`resolveOwnShare` / `isRouteStateFallbackActive`) and is shared with the
 * MTA-facing code; this module is only the database seam.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type {
	DeliverabilityCell,
	DeliverabilitySignalProvider,
} from '@owlat/shared/deliverabilityRouting';

/** The all-stream row for a provider slice: what the MTA snapshot maintains. */
export async function loadStreamlessRouteState(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	destinationProvider: DeliverabilitySignalProvider
): Promise<Doc<'deliverabilityRouteStates'> | null> {
	return await ctx.db
		.query('deliverabilityRouteStates')
		.withIndex('by_org_provider_stream', (q) =>
			q
				.eq('organizationId', organizationId)
				.eq('destinationProvider', destinationProvider)
				.eq('stream', undefined)
		)
		.first();
}

/** Both rows backing one ramp cell. Either may be absent. */
export interface RouteStateCellRows {
	/** The ramp controller's row: the cell's share. Absent until P3-2 writes one. */
	perStream: Doc<'deliverabilityRouteStates'> | null;
	/** The MTA snapshot's (and legacy) row: the infrastructure verdict + signals. */
	streamless: Doc<'deliverabilityRouteStates'> | null;
}

/**
 * Cell lookup. Returns BOTH rows so no caller can let one shadow the other;
 * share resolution is `perStream ?? streamless` on top of this, while signals
 * and the fallback boolean must be read from EVERY non-null row.
 *
 * The global `'all'` slice is infrastructure-wide and never per-stream, so it
 * is not a cell: read it with `loadStreamlessRouteState(ctx, org, 'all')`.
 */
export async function loadRouteStateCell(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	cell: DeliverabilityCell
): Promise<RouteStateCellRows> {
	const [perStream, streamless] = await Promise.all([
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider_stream', (q) =>
				q
					.eq('organizationId', organizationId)
					.eq('destinationProvider', cell.destinationProvider)
					.eq('stream', cell.stream)
			)
			.first(),
		loadStreamlessRouteState(ctx, organizationId, cell.destinationProvider),
	]);
	return { perStream, streamless };
}
