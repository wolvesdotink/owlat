/**
 * Whether a route splits traffic by the cell's share at all: the precondition
 * every seam that acts on a split asks, so the ramp's enrolment door, the
 * enqueue-side recording (`cellRoute.ts`) and the dispatch-time router
 * (`route.ts`, `routeMixContext.ts`) cannot disagree about whether a split is
 * happening.
 *
 * A leaf on purpose: `cellRoute.ts` runs inside the enqueue transaction and is
 * imported by the assignment writer, so this module must not import the
 * per-message mix concern (which reads the recorded assignment back) or
 * anything that reads `providerHealth`.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { MessageType } from './routeInputs';

/**
 * WHETHER A ROUTE SPLITS TRAFFIC BY THE CELL'S SHARE AT ALL.
 *
 * `adaptive_mix` is the only strategy that reads a mix context, so it is the
 * only one under which a stored `ownShare` moves a single message: on `single`,
 * `priority_failover` and `workload_split` the share is a number the controller
 * keeps and the router never consults. Stated ONCE, here, because every seam
 * that acts on a split asks it: `mixContextFor` in `routeMixContext.ts`, the
 * `wantsMix` guard in `route.ts`, the enqueue-side cell seam in `cellRoute.ts`,
 * and the ramp's enrolment door — which must not tell an operator a relay is
 * carrying 98% of a cell whose route cannot express a split. A second splitting
 * strategy is then one edit here, not four that have to be found.
 */
export function isShareSplitRoute(routeConfig: Doc<'providerRoutes'> | null): boolean {
	return routeConfig?.strategy === 'adaptive_mix';
}

/**
 * The same question asked about a STREAM rather than about a row already in
 * hand: one route row per message type, on the shipped index.
 */
export async function isStreamShareSplitRouted(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType
): Promise<boolean> {
	return isShareSplitRoute(
		await ctx.db
			.query('providerRoutes')
			.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
			.first()
	);
}
