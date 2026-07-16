/**
 * Delivery-provider capability — "is a provider actually configured?"
 *
 * This is the backend half of the operating-modes invariant. The browser-safe
 * `needsDeliveryProvider` predicate (`@owlat/shared`) answers whether a flag
 * posture NEEDS a delivery provider; this module answers whether one is
 * PRESENT. The send entry points (`campaigns/preflight.ts`,
 * `transactional/dispatch.ts`) call `isDeliveryConfigured` to refuse an
 * unsendable configuration up front instead of marching every recipient to
 * `failed` against a provider that was never set up.
 *
 * Fail-CLOSED: an unset or unrecognized `EMAIL_PROVIDER` returns `false` rather
 * than silently defaulting to the MTA. This deliberately mirrors the
 * fail-closed routing change (`routing.ts`) — "no provider" is a real,
 * answerable state, not an implicit MTA.
 */

import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import { getOptional, isEnvPresent } from '../env';
import { authorizeSystemBundledPlugin } from '../../plugins/authorization';
import { isCoreSendProviderKind, sendProviderCatalogEntry } from './catalog';
import { isSendProviderKind } from './types';
import type { SendProviderKind } from './types';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';

/**
 * True iff the given provider kind has the credentials it needs in the
 * environment. The one place per-kind cred requirements live.
 */
export function providerKindConfigured(kind: SendProviderKind): boolean {
	return sendProviderCatalogEntry(kind).requiredEnvVars.every(isEnvPresent);
}

/** Full runtime readiness, including mutable flag and capability-grant state. */
export async function isSendProviderReady(
	ctx: QueryCtx | MutationCtx,
	kind: SendProviderKind
): Promise<boolean> {
	if (!providerKindConfigured(kind)) return false;
	if (isCoreSendProviderKind(kind)) return true;
	const pluginId = sendProviderCatalogEntry(kind).pluginId;
	if (!pluginId) return false;
	return Boolean(
		await authorizeSystemBundledPlugin(ctx, pluginId, PLUGIN_SEND_TRANSPORT_CAPABILITY)
	);
}

/**
 * Environment-fallback readiness check. `EMAIL_PROVIDER` must name a composed
 * provider kind, and that provider must pass the same credentials, flag, and
 * capability-grant checks used by route resolution. Core providers retain
 * their exact credential-only behavior.
 */
export async function deliveryConfiguredFromEnv(ctx: QueryCtx | MutationCtx): Promise<boolean> {
	const provider = getOptional('EMAIL_PROVIDER');
	if (!isSendProviderKind(provider)) return false;
	return await isSendProviderReady(ctx, provider);
}

/** Action-callable environment readiness check with no route fallback. */
export const environmentSendProviderReady = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => await deliveryConfiguredFromEnv(ctx),
});

/** The message types a `providerRoutes` row can target. */
export type DeliveryMessageType = 'campaign' | 'transactional' | 'automation';

/**
 * True iff this deployment can actually deliver mail. A `providerRoutes` row
 * with at least one enabled provider whose credentials are present wins;
 * otherwise the env configuration decides. `providerRoutes` is bounded (one row
 * per message type, single org per deployment), so the full scan is cheap.
 *
 * Pass `messageType` to match the route resolution the send path will actually
 * use (`resolveSendRouteFromDb(messageType)`): without it, a route configured
 * for *one* message type would make the gate pass for a *different*, unrouted
 * type that then resolves to env (possibly nothing) and fails in the worker.
 * Omit it for the general "can this instance send at all?" question (the admin
 * Features hint).
 */
export async function isDeliveryConfigured(
	ctx: QueryCtx | MutationCtx,
	messageType?: DeliveryMessageType
): Promise<boolean> {
	const routes = await ctx.db.query('providerRoutes').collect(); // bounded: configured provider routes (few)
	for (const route of routes) {
		if (messageType && route.messageType !== messageType) continue;
		for (const provider of route.providers) {
			if (
				provider.isEnabled &&
				isSendProviderKind(provider.providerType) &&
				(await isSendProviderReady(ctx, provider.providerType))
			) {
				return true;
			}
		}
	}
	return await deliveryConfiguredFromEnv(ctx);
}
