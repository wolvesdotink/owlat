/**
 * The inputs a send-route decision is made from.
 *
 * Split out of `route.ts` so the AUTHORITATIVE per-message resolver
 * (`route.ts`) and the health-free per-cell BATCH seam (`cellRoute.ts`) read
 * the same documents through the same helpers and cannot drift about what
 * "enabled", "fresh" or "fallback active" mean.
 *
 * The one thing that is deliberately NOT shared is provider readiness: the
 * per-message resolver may resolve the mutable plugin capability grant, and
 * the batch seam may not. See the two predicates below.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { isSendProviderReady, providerKindConfigured } from './capability';
import { isSendProviderKind, type SendProviderKind } from './types';
import { getOptional } from '../env';
import { extractDomainOrNull } from '@owlat/shared';
import {
	isActionableDeliverabilitySignalSource,
	isRouteStateFallbackActive,
	type ActionableDeliverabilitySignalSource,
} from '@owlat/shared/deliverabilityRouting';
import { relayDomainVerified } from './relayDomainVerification';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../delivery/deliverabilityRouting';

/**
 * The route table a message resolves against. It lives HERE, next to the
 * inputs both resolvers share, rather than in `route.ts`: the health-free cell
 * seam needs it too, and importing it from the per-message resolver would give
 * the seam an import edge to the one module it must never call. `route.ts`
 * re-exports both for existing importers.
 */
export type MessageType = Doc<'providerRoutes'>['messageType'];

/**
 * Single source of truth for the message-type literal set (imported by
 * `providerRoutes.ts` so the two can't drift).
 */
export const messageTypeValidator = v.union(
	v.literal('campaign'),
	v.literal('transactional'),
	v.literal('automation')
);

/**
 * The provider kinds this route config could select: the ENABLED ones named on
 * the route plus the `EMAIL_PROVIDER` env fallback. Pure — no document reads.
 *
 * Both sources, because resolution has both: a deployment only gets a
 * `providerRoutes` row once an operator saves the routing screen, so on the
 * canonical bring-your-own-relay install (`EMAIL_PROVIDER=smtp` + `SMTP_RELAY_*`,
 * no routing row) the relay is reached exclusively through `resolveRoute`'s env
 * fallback. Anything that asks "could this message go out over kind X?" must ask
 * THIS function, or it will be narrower than what `resolveRoute` can return.
 *
 * Disabled entries are excluded HERE, in the one place, because `resolveRoute`
 * drops them before readiness is ever asked (`routing.ts`) — so they can never
 * be selected, and every caller deserves the same answer about that.
 */
export function candidateSendProviderKinds(
	routeConfig: Doc<'providerRoutes'> | null
): Set<SendProviderKind> {
	const candidateKinds = new Set<SendProviderKind>();
	for (const provider of routeConfig?.providers ?? []) {
		if (provider.isEnabled && isSendProviderKind(provider.providerType)) {
			candidateKinds.add(provider.providerType);
		}
	}
	const envProvider = getOptional('EMAIL_PROVIDER');
	if (isSendProviderKind(envProvider)) candidateKinds.add(envProvider);
	return candidateKinds;
}

/**
 * Which provider kinds are runtime-ready for this route config (credentials +
 * flag + capability grant). Used by the AUTHORITATIVE per-message resolver.
 *
 * NOT usable on the batch/cell seam: for a non-core kind `isSendProviderReady`
 * falls through to the plugin capability grant, which reads a deployment
 * singleton — a document the transactional send path patches on every send.
 * See {@link configuredSendProviderKinds}.
 */
export async function readySendProviderKinds(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null
): Promise<Set<SendProviderKind>> {
	const readyKinds = new Set<SendProviderKind>();
	for (const kind of candidateSendProviderKinds(routeConfig)) {
		if (await isSendProviderReady(ctx, kind)) readyKinds.add(kind);
	}
	return readyKinds;
}

/**
 * The batch/cell seam's readiness predicate: credentials only, ZERO document
 * reads (`providerKindConfigured` is env-only).
 *
 * The difference from {@link readySendProviderKinds} is the mutable plugin
 * capability grant, and dropping it is deliberate. Resolving that grant reaches
 * a deployment-wide singleton document that the transactional send path patches
 * on every send; taking a read dependency on it inside a campaign enqueue
 * transaction — the one that also performs ~50 workpool enqueues — is exactly
 * the OCC-retry-exhaustion failure the cell seam exists to avoid, and the
 * documented consequence is a lost page with its recipients stuck queued.
 *
 * What the omission can cost: if a plugin transport's grant is revoked between
 * enqueue and dispatch, the recorded assignment row names the transport the
 * route WOULD have selected while the worker re-resolves authoritatively and
 * sends elsewhere. That is a slightly stale measurement row, which is the same
 * trade already accepted there for `providerHealth`. A stale row is cheap; a
 * failed enqueue transaction is not.
 */
export function configuredSendProviderKinds(
	routeConfig: Doc<'providerRoutes'> | null
): Set<SendProviderKind> {
	const configured = new Set<SendProviderKind>();
	for (const kind of candidateSendProviderKinds(routeConfig)) {
		if (providerKindConfigured(kind)) configured.add(kind);
	}
	return configured;
}

/**
 * Fallback reasons carried by the FRESH active route states, in order.
 *
 * Advisory readings ("blocklist lookup unavailable", "part of the pool is
 * ejected") are recorded on the state row for measurement, but they are not
 * routing reasons and must never appear as the cause of a relay fallback —
 * nor as the cause of a `reference` arm on a send assignment. One filter,
 * both call sites.
 *
 * Callers pass EVERY row a decision keys off — the org-wide row plus BOTH rows
 * of the cell — because the per-stream row carries the controller's share and
 * the stream-less row carries the infrastructure signals, so reading only one
 * would drop a hard stop. "Active" is `isRouteStateFallbackActive`, the union
 * of the stored boolean and D1's resolved share, so a legacy row still
 * resolves to exactly its stored boolean.
 */
export function freshFallbackReasons(
	states: ReadonlyArray<Doc<'deliverabilityRouteStates'> | null>,
	now: number
): ActionableDeliverabilitySignalSource[] {
	return states
		.filter(
			(state): state is Doc<'deliverabilityRouteStates'> =>
				state !== null &&
				isRouteStateFallbackActive(state) &&
				now - state.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS
		)
		.flatMap((state) =>
			state.signals.map((signal) => signal.source).filter(isActionableDeliverabilitySignalSource)
		);
}

/** True when the org-wide state carries a fresh `breaker_open` signal. */
export function isGlobalBreakerOpenState(
	globalState: Doc<'deliverabilityRouteStates'> | null,
	now: number
): boolean {
	return Boolean(
		globalState &&
		isRouteStateFallbackActive(globalState) &&
		now - globalState.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
		globalState.signals.some((signal) => signal.source === 'breaker_open')
	);
}

/** Relay-domain verification for the envelope From, when a relay is configured. */
export async function relayDomainVerifiedFor(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	from: string | undefined,
	now: number
): Promise<boolean> {
	const fromDomain = from ? extractDomainOrNull(from) : null;
	if (!fromDomain || !routeConfig?.deliverabilityFallback?.isEnabled) return false;
	return await relayDomainVerified(
		ctx,
		fromDomain,
		routeConfig.deliverabilityFallback.relayProviderType,
		now
	);
}
