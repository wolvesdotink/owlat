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
 *
 * ELIGIBILITY IS NOT SUFFICIENCY. This answers "may this KIND relay at all",
 * never "may it relay THIS domain" — the per-domain proof gate (D7,
 * `relayDomainVerification.ts`) stands in front of every kind that gets past
 * here. The two compose into one configuration worth knowing about: a kind
 * whose catalog entry declares `domainVerification: 'none'` (`resend`, a
 * bring-your-own `smtp` relay) is eligible and saveable, has no sending-domain
 * provider to register an identity at, and therefore never clears the proof
 * gate — so the operator learns of it only when the breaker opens and the send
 * is refused. Pinned end to end by "saves a relay with no identity API, which
 * then never clears the proof gate" in
 * `convex/__tests__/providerRoutes.integration.test.ts`.
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

/**
 * One entry of a `providerRoutes` row's `providers` array, structurally: the
 * two fields both predicates below read. Structural rather than
 * `Doc<'providerRoutes'>['providers'][number]` so this module keeps no schema
 * edge — `setRoute` asks it of the arguments it is about to persist and the
 * checklist asks it of the row it just read, and neither has to convert.
 */
export type RouteProviderEntry = { readonly providerType: string; readonly isEnabled: boolean };

/**
 * Is `relayKind` a LIVE ARM of this route, and not merely the kind its fallback
 * names?
 *
 * The second of the three conditions an enabled deliverability fallback has to
 * satisfy — eligibility ({@link isFallbackRelayEligible}), this pairing, and
 * the own arm ({@link routeCarriesOwnArm}) — and the reason it lives here
 * rather than inline at `setRoute` is that `setRoute` is not the only asker:
 * the `deployment.relay` checklist item reports the same route as ready or not,
 * and a checklist that re-expressed the rule would go on reporting a route as
 * unready after the mutation learned to accept it (or the reverse). Two copies
 * of a save-time rule drift in whichever direction the next change moves one of
 * them; the expensive one is the checklist telling an operator their perfectly
 * saveable route is broken, which is the exact bug the leak sweep just removed
 * from this item.
 */
export function routeCarriesEnabledRelay(
	providers: readonly RouteProviderEntry[],
	relayKind: string
): boolean {
	return providers.some((provider) => provider.isEnabled && provider.providerType === relayKind);
}

/**
 * Does this route carry the arm a fallback moves traffic AWAY from?
 *
 * The third condition, and the one a route cannot be a fallback route without:
 * a deliverability fallback is by definition traffic leaving our own
 * infrastructure for a relay, so a route with no enabled own-MTA arm has
 * nothing to fall back FROM.
 *
 * D3's one sanctioned identity — own arm vs. everything else — read from its
 * SINGLE declaration. `OWN_ARM_TRANSPORT_KIND` is the same constant the
 * adaptive mix splits its arms on, which is what keeps this precondition and
 * that split from ever meaning two different transports.
 */
export function routeCarriesOwnArm(providers: readonly RouteProviderEntry[]): boolean {
	return providers.some(
		(provider) => provider.isEnabled && provider.providerType === OWN_ARM_TRANSPORT_KIND
	);
}
