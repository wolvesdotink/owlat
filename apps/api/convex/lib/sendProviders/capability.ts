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

import { getOptional } from '../env';
import { isSendProviderKind } from './index';
import type { SendProviderKind } from './types';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

/**
 * True iff the given provider kind has the credentials it needs in the
 * environment. The one place per-kind cred requirements live.
 */
export function providerKindConfigured(kind: SendProviderKind): boolean {
	switch (kind) {
		case 'mta':
			return Boolean(getOptional('MTA_API_URL') && getOptional('MTA_API_KEY'));
		case 'resend':
			return Boolean(getOptional('RESEND_API_KEY'));
		case 'ses':
			return Boolean(
				getOptional('AWS_SES_ACCESS_KEY_ID') && getOptional('AWS_SES_SECRET_ACCESS_KEY')
			);
	}
}

/**
 * Env-only capability check: `EMAIL_PROVIDER` names a real kind AND its
 * credentials are present. Returns false when `EMAIL_PROVIDER` is unset or not
 * one of `mta|resend|ses` (no implicit MTA default).
 */
export function deliveryConfiguredFromEnv(): boolean {
	const provider = getOptional('EMAIL_PROVIDER');
	if (!isSendProviderKind(provider)) return false;
	return providerKindConfigured(provider);
}

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
		const hasUsableProvider = route.providers.some(
			(p) =>
				p.isEnabled && isSendProviderKind(p.providerType) && providerKindConfigured(p.providerType)
		);
		if (hasUsableProvider) return true;
	}
	return deliveryConfiguredFromEnv();
}
