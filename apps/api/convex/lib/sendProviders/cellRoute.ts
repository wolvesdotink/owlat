/**
 * Per-CELL route resolution for BATCH callers, from cold/warm inputs only.
 *
 * `resolveSendRouteFromDb` (`route.ts`) is the authoritative per-message
 * resolution and it reads `providerHealth` — a document that is
 * read-modify-written once per dispatch (`health.ts recordSendResult`).
 * Pulling that hotspot into a campaign enqueue transaction (which also
 * performs ~50 workpool enqueues) would make every concurrent dispatch
 * invalidate the enqueue's read set and drive OCC retries on a transaction
 * that must not fail. So this seam answers the DELIVERABILITY question — "does
 * this cell relay, and to which transport?" — from inputs that no send patches:
 *
 *   - `providerRoutes` (indexed, admin-written),
 *   - `deliverabilityRouteStates` (`by_org_provider`, written by the
 *     ip-reputation sync cron),
 *   - the relay-domain verification (`domains` /
 *     `sendingDomainSesIdentities`, both admin/verification-written).
 *
 * Provider readiness is answered from the ENVIRONMENT only
 * (`configuredSendProviderKinds`) for the same reason — see its docstring.
 *
 * Deliberately NOT read here:
 *   - `providerHealth` — health-driven failover stays with the worker's
 *     authoritative re-resolution at dispatch (`governedDispatch.ts`);
 *   - `warmingState` — warm-up overflow is a point-in-time volume condition,
 *     and the timezone branch enqueues up to 24h before dispatch, so an
 *     enqueue-time reading of it would predict nothing.
 *
 * A cell resolves to `null` when nothing can be recorded honestly:
 *   - no route at all;
 *   - the org-wide delivery circuit is open (the message is not going
 *     anywhere right now);
 *   - the route resolved through a NON-DETERMINISTIC strategy
 *     (`workload_split` draws at random per call). This seam resolves once
 *     per cell, but the worker draws again independently per recipient at
 *     dispatch, so one draw stamped on N rows would be wrong for roughly
 *     half of them. P2-5 replaces the draw with the deterministic
 *     per-recipient hash; until then the honest record is silence.
 *
 * In every case: a guessed arm is worse than a missing row.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { resolveRoute, type ProviderRouteConfig, type ResolvedRoute } from './routing';
import { isDeterministicRouteStrategy } from './strategies';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { MessageType } from './route';
import {
	configuredSendProviderKinds,
	deliverabilityRouteStateFor,
	freshFallbackReasons,
	isGlobalBreakerOpenState,
	relayDomainVerifiedFor,
} from './routeInputs';

/** Batch-wide inputs for {@link prepareCellRouteResolver}. */
export interface CellRouteContext {
	/** Envelope From; feeds the shipped relay-domain verification input. */
	readonly from?: string;
	readonly now: number;
	readonly organizationId: string;
}

/**
 * Resolve one cell, given a batch's already-read inputs. Issues at most ONE
 * document read per call (the cell's `deliverabilityRouteStates` row).
 */
export type CellRouteResolver = (
	destinationProvider: DestinationProviderKey
) => Promise<ResolvedRoute | null>;

/**
 * Prepare-once, resolve-per-cell.
 *
 * Three of the four inputs a cell decision needs — the route config, the
 * configured-kind set and the relay-domain verification — do not depend on the
 * destination provider at all. Reading them once per BATCH instead of once per
 * cell keeps a mixed page from issuing up to `DESTINATION_PROVIDER_KEYS.length`
 * redundant copies of each, and every read avoided is a read the enqueue
 * transaction does not carry.
 */
export async function prepareCellRouteResolver(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType,
	context: CellRouteContext
): Promise<CellRouteResolver> {
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
	const globalState = await deliverabilityRouteStateFor(ctx, context.organizationId, 'all');
	// The org-wide circuit answers for every cell, so settle it before paying
	// for the relay-verification reads none of them would use.
	if (isGlobalBreakerOpenState(globalState, context.now)) return async () => null;
	const configuredKinds = configuredSendProviderKinds(routeConfig);
	const isRelayDomainVerified = await relayDomainVerifiedFor(
		ctx,
		routeConfig,
		context.from,
		context.now
	);
	const isDeterministic = isDeterministicRouteStrategy(routeConfig?.strategy);
	return async (destinationProvider) => {
		const providerState = await deliverabilityRouteStateFor(
			ctx,
			context.organizationId,
			destinationProvider
		);
		const resolved = resolveRoute(
			routeConfig as ProviderRouteConfig | null,
			undefined,
			(kind) => configuredKinds.has(kind),
			{
				activeReasons: freshFallbackReasons([globalState, providerState], context.now),
				isWarmupOverflow: false,
				isRelayDomainVerified,
			}
		);
		// Only an `org_config` selection came out of the strategy; a
		// deliverability fallback and the env fallback are both deterministic by
		// construction.
		if (resolved?.source === 'org_config' && !isDeterministic) return null;
		return resolved;
	};
}
