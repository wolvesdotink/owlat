/**
 * Deliverability route-state lookup (the D1 resolution seam).
 *
 * One place that knows how a `(organizationId, destinationProvider, stream)`
 * ramp cell maps onto `deliverabilityRouteStates` rows, so the stream widening
 * cannot fork into per-caller lookup rules:
 *
 *  - a per-stream row wins when one exists for the requested stream;
 *  - otherwise the LEGACY stream-less row serves every stream, which is what
 *    keeps rows written before the migration (and the shipped MTA snapshot,
 *    which still writes stream-less rows) working unchanged.
 *
 * Share resolution itself lives in `@owlat/shared/deliverabilityRouting`
 * (`resolveOwnShare` / `isRouteStateFallbackActive`) and is shared with the
 * MTA-facing code; this module is only the database seam.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type {
	DeliverabilitySignalProvider,
	DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';

export type DeliverabilityRouteStateDoc = Doc<'deliverabilityRouteStates'>;

/** The all-stream row for a provider slice: what the MTA snapshot maintains. */
export async function loadStreamlessRouteState(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	destinationProvider: DeliverabilitySignalProvider
): Promise<DeliverabilityRouteStateDoc | null> {
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

/**
 * Cell lookup: the per-stream row when one exists, else the legacy
 * stream-less row. Passing no stream asks for the stream-less row directly.
 */
export async function loadRouteStateForCell(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	destinationProvider: DeliverabilitySignalProvider,
	stream?: DeliverabilityStream
): Promise<DeliverabilityRouteStateDoc | null> {
	if (stream !== undefined) {
		const perStream = await ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider_stream', (q) =>
				q
					.eq('organizationId', organizationId)
					.eq('destinationProvider', destinationProvider)
					.eq('stream', stream)
			)
			.first();
		if (perStream) return perStream;
	}
	return await loadStreamlessRouteState(ctx, organizationId, destinationProvider);
}
