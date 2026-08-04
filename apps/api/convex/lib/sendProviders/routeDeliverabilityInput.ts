/**
 * The deliverability half of the per-message route inputs.
 *
 * Split out of `route.ts` (which owns the read/select halves of route
 * resolution and the governed last-mile plan) so the signal read — route
 * state, warming state and relay-domain verification — has one home. The
 * caller resolves the tenant + cell ONCE and hands the still-pending cell read
 * in, so the three reads here overlap inside one parallel read set.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { loadStreamlessRouteState } from '../deliverabilityRouteState';
import type { ResolvedAddressCell, SendRouteAddressContext } from './routeMixContext';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../delivery/deliverabilityRouting';
import type { DeliverabilityRouteInput } from './routing';
import {
	freshFallbackReasons,
	isGlobalBreakerOpenState,
	relayDomainVerifiedFor,
	type MessageType,
} from './routeInputs';

export async function deliverabilityInput(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	messageType: MessageType,
	addressContext: SendRouteAddressContext | undefined,
	resolved: ResolvedAddressCell | null
): Promise<DeliverabilityRouteInput | undefined> {
	if (!addressContext?.to) return undefined;
	// The tenant, the recipient's cell and the resolution clock all come from
	// the ONE `resolveAddressCell` the caller already ran; a null bundle (no
	// tenant) means there is no deliverability input to give, exactly as before.
	if (resolved === null) return undefined;
	const { organizationId, now } = resolved;
	// The cell read is still in flight, so it overlaps the other two — the shape
	// this function had when it issued the cell read itself.
	const [providerCell, globalState, warmingState] = await Promise.all([
		resolved.cell,
		// The global slice is infrastructure-wide and never per-stream: read the
		// stream-less row directly so a per-stream `all` row could never hide the
		// breaker_open signal the snapshot writes there.
		loadStreamlessRouteState(ctx, organizationId, 'all'),
		messageType === 'campaign' && routeConfig?.deliverabilityFallback?.isWarmupOverflowEnabled
			? ctx.db.query('warmingState').first()
			: Promise.resolve(null),
	]);
	// A null cell (no parseable recipient domain) means there is nothing to key
	// the deliverability signals off, exactly as before.
	if (providerCell === null) return undefined;
	// EVERY row of the cell is considered, not just the most specific one: the
	// per-stream row carries the controller's share and the stream-less row
	// carries the infrastructure signals, so reading only one would drop a hard
	// stop. `freshFallbackReasons` applies D1's share resolution and the
	// advisory-signal filter for both call sites.
	const activeReasons = freshFallbackReasons(
		[globalState, providerCell.streamless, providerCell.perStream],
		now
	);
	if (addressContext.forceRelayReason === 'breaker_open') activeReasons.unshift('breaker_open');
	const isWarmupOverflow = Boolean(
		addressContext.forceRelayReason === 'warmup_overflow' ||
		(warmingState &&
			now - warmingState.syncedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
			warmingState.phase !== 'graduated' &&
			warmingState.totalDailyCap > 0 &&
			warmingState.totalSentToday >= warmingState.totalDailyCap)
	);
	const isRelayDomainVerified = await relayDomainVerifiedFor(
		ctx,
		routeConfig,
		addressContext.from,
		now
	);
	const isGlobalBreakerOpen = isGlobalBreakerOpenState(globalState, now);
	return { activeReasons, isWarmupOverflow, isRelayDomainVerified, isGlobalBreakerOpen };
}
