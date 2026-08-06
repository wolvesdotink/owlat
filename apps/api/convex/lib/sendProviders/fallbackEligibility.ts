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
 * Isolate-safe: the catalog and the own-arm constant only — both pure modules,
 * no env reads and no `'use node'` edges (the same import `warmingCapGate.ts`
 * takes for the same constant, on the same enqueue path).
 */

import { isSendProviderKind, type SendProviderKind } from './catalog';
import { OWN_ARM_TRANSPORT_KIND } from './strategies/adaptive_mix';

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
	// D3's one sanctioned identity — own arm vs. everything else — read from its
	// SINGLE declaration rather than restated here. `OWN_ARM_TRANSPORT_KIND` is
	// the same constant `adaptive_mix` splits its arms on, which is what keeps
	// "the arm a fallback moves traffic away from" and "the arm the mix calls
	// own" from ever meaning two different transports.
	if (kind === OWN_ARM_TRANSPORT_KIND) return false;
	return isConfigured(kind);
}
