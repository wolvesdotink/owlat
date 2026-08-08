/**
 * Deliverability-fallback relay eligibility (plan D6).
 *
 * "May this kind be the relay we fall back TO?" — asked of the CATALOG rather
 * than of a hard-coded identity. The shipped gate was
 * `relayProviderType !== 'ses' → throw`, which is not a capability at all: it
 * is a list of one, and every future relay had to edit routing logic to join
 * it. The question the gate actually wants to ask has two halves, and both are
 * answerable without naming a provider:
 *
 *   1. Is it a transport this deployment knows about, and is it not our own
 *      MTA? The MTA is the arm a fallback moves traffic AWAY from — routing it
 *      to itself would "relieve" a reputation problem through the very
 *      transport that has it.
 *   2. Is it CONFIGURED? A relay whose credentials are absent is not a
 *      fallback, it is a second outage.
 *
 * Configured-ness is INJECTED rather than read here, because the two callers
 * legitimately have different sources for it and must not disagree with
 * themselves: `resolveRoute` already carries a readiness predicate (env plus,
 * off the hot path, mutable plugin grants) and gates its whole provider list on
 * it, so the relay must be judged by that same predicate; a caller with nothing
 * else in hand passes `providerKindConfigured`, the deployment's env-only
 * credential source. Either way this module owns the RULE and never the
 * evidence.
 *
 * Isolate-safe: catalog types only, no env and no `'use node'` edges.
 */

import { isSendProviderKind, type SendProviderKind } from './catalog';

/**
 * True iff `kind` may serve as the deliverability fallback relay, judged
 * against the caller's own `isConfigured` source (see the module docblock).
 *
 * Fails closed on everything it cannot vouch for: an unknown or retired kind,
 * the owned MTA, and any kind `isConfigured` rejects.
 */
export function isFallbackRelayEligible(
	kind: string | null | undefined,
	isConfigured: (kind: SendProviderKind) => boolean
): boolean {
	if (!isSendProviderKind(kind)) return false;
	if (kind === 'mta') return false;
	return isConfigured(kind);
}
